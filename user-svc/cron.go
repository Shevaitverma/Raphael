package main

import (
	"fmt"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata" // embed the IANA tz database so LoadLocation works in a scratch container
)

// Dependency-free 5-field cron evaluator + next_fire advance for reminders.
//
// A reminder's schedule is EITHER kind="once" (fire at fireAt, then done) or
// kind="cron" (a standard "min hour dom month dow" expression, evaluated in the
// user's IANA timezone). next_fire is the single poll key: the scheduler in
// store.go claims rows with next_fire<=now, delivers, then calls computeNext to
// advance it (or deactivate). Runtime is LLM-free — the NL was compiled to this
// structured schedule ONCE at authoring.

// cronField is the allowed-value set for one cron position. star records whether
// the raw field was "*", which the dom/dow OR-vs-AND rule needs (see matches).
type cronField struct {
	set  map[int]bool
	star bool
}

func (c cronField) contains(v int) bool { return c.set[v] }

type cronSpec struct {
	min, hour, dom, month, dow cronField
}

// parseField expands one comma-separated field into its value set. Supports the
// forms the compiler emits: "*", "a", "a-b", "a,b", "*/n" (and "a-b/n" for free).
func parseField(f string, min, max int) (cronField, error) {
	cf := cronField{set: map[int]bool{}}
	if f == "*" {
		cf.star = true
	}
	for _, term := range strings.Split(f, ",") {
		lo, hi, step := min, max, 1
		body := term
		if i := strings.IndexByte(term, '/'); i >= 0 {
			s, err := strconv.Atoi(term[i+1:])
			if err != nil || s <= 0 {
				return cf, fmt.Errorf("bad step in %q", term)
			}
			step = s
			body = term[:i]
		}
		switch {
		case body == "*":
			lo, hi = min, max
		case strings.ContainsRune(body, '-'):
			p := strings.SplitN(body, "-", 2)
			a, err1 := strconv.Atoi(p[0])
			b, err2 := strconv.Atoi(p[1])
			if err1 != nil || err2 != nil {
				return cf, fmt.Errorf("bad range %q", term)
			}
			lo, hi = a, b
		default:
			a, err := strconv.Atoi(body)
			if err != nil {
				return cf, fmt.Errorf("bad value %q", term)
			}
			lo, hi = a, a
		}
		if lo < min || hi > max || lo > hi {
			return cf, fmt.Errorf("value %q out of range %d-%d", term, min, max)
		}
		for v := lo; v <= hi; v += step {
			cf.set[v] = true
		}
	}
	return cf, nil
}

// parseCron parses a 5-field expression. dow accepts 0-7 with 7 folded to Sunday.
func parseCron(expr string) (cronSpec, error) {
	fields := strings.Fields(expr)
	if len(fields) != 5 {
		return cronSpec{}, fmt.Errorf("cron must have 5 fields, got %d in %q", len(fields), expr)
	}
	var sp cronSpec
	var err error
	if sp.min, err = parseField(fields[0], 0, 59); err != nil {
		return sp, err
	}
	if sp.hour, err = parseField(fields[1], 0, 23); err != nil {
		return sp, err
	}
	if sp.dom, err = parseField(fields[2], 1, 31); err != nil {
		return sp, err
	}
	if sp.month, err = parseField(fields[3], 1, 12); err != nil {
		return sp, err
	}
	if sp.dow, err = parseField(fields[4], 0, 7); err != nil {
		return sp, err
	}
	if sp.dow.set[7] { // 7 == Sunday, same as 0
		sp.dow.set[0] = true
	}
	return sp, nil
}

// matches reports whether wall-clock time t (already in the target tz) satisfies
// the spec. Standard cron day rule: when BOTH dom and dow are restricted it's an
// OR; if either is "*" it's an AND (the "*" side is always true, so it collapses
// to the restricted one). Our examples restrict only dow, so this is just dow.
func (sp cronSpec) matches(t time.Time) bool {
	if !sp.min.contains(t.Minute()) || !sp.hour.contains(t.Hour()) || !sp.month.contains(int(t.Month())) {
		return false
	}
	domMatch := sp.dom.contains(t.Day())
	dowMatch := sp.dow.contains(int(t.Weekday())) // Go: Sunday=0..Saturday=6
	if sp.dom.star || sp.dow.star {
		return domMatch && dowMatch
	}
	return domMatch || dowMatch
}

// nextFire returns the first cron slot STRICTLY after `after`, evaluated in loc,
// as a UTC instant. It walks wall-clock minute-by-minute (cheap: <2yr of minutes)
// so DST transitions are handled by the tz db, not arithmetic. The ~2yr cap makes
// an unsatisfiable spec (e.g. Feb 30) fail loudly instead of spinning forever.
// ponytail: O(minutes) linear scan — fine at ~1M iters/call; swap for a
// field-jump nextFire only if scheduling ever runs hot.
func nextFire(after time.Time, sp cronSpec, loc *time.Location) (time.Time, bool) {
	t := after.In(loc).Truncate(time.Minute)
	const capMinutes = 2 * 366 * 24 * 60 // ~2 years
	for i := 0; i < capMinutes; i++ {
		t = t.Add(time.Minute) // start strictly after `after`
		if sp.matches(t) {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}

// computeNext computes a reminder's next_fire (UTC), or nil to DEACTIVATE it.
//
//	now    the anchor: creation time when first scheduling, or the poll time when
//	       advancing after a fire. For cron, next_fire is the first slot after now,
//	       so a long outage collapses all missed slots into ONE catch-up fire.
//	fired  false when computing the initial next_fire at creation; true when
//	       advancing after the scheduler delivered this fire.
//
// once: initial -> fireAt; after firing -> nil (deactivate, it fired its one time).
// cron: first slot after now; nil if that slot is past `until` (the "today only"
// bound closes here). A missing/invalid schedule returns an error so the caller
// rejects it up front rather than creating a reminder that silently never fires.
func computeNext(now time.Time, kind, cron string, fireAt, until *time.Time, tz string, fired bool) (*time.Time, error) {
	switch kind {
	case "once":
		if fireAt == nil {
			return nil, fmt.Errorf("once reminder requires a fire time")
		}
		if fired {
			return nil, nil // single-shot: already delivered, deactivate
		}
		f := fireAt.UTC()
		return &f, nil
	case "cron":
		if strings.TrimSpace(cron) == "" {
			return nil, fmt.Errorf("cron reminder requires a schedule")
		}
		loc, err := time.LoadLocation(tz)
		if err != nil {
			return nil, fmt.Errorf("invalid timezone %q: %w", tz, err)
		}
		sp, err := parseCron(cron)
		if err != nil {
			return nil, err
		}
		nf, ok := nextFire(now, sp, loc)
		if !ok {
			return nil, fmt.Errorf("cron %q has no fire within 2 years", cron)
		}
		if until != nil && nf.After(until.UTC()) {
			return nil, nil // past the bound: deactivate
		}
		return &nf, nil
	default:
		return nil, fmt.Errorf("unknown reminder kind %q", kind)
	}
}
