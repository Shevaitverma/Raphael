package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Fitness coaching scheduler: a sibling of the reminder scheduler (reminders.go).
// LLM-free — every message is a templated "coach" string. Ticks every 60s and,
// per enabled fitness_config row, fires up to three actions into the SAME
// notifications table the reminder sink uses (reminder_id stays NULL).
//
// Idempotency is by last_*_at stamps, not by locking history: each fire stamps
// its clock (last_checkin_at / last_weekly_at / fitness_goals.last_nudge_at) so a
// re-tick 60s later re-reads the stamp and skips. Like fireDue, the row is claimed
// FOR UPDATE SKIP LOCKED inside the firing tx, so a second instance never
// double-sends. All time math is in the user's IANA tz (users.timezone), mirroring
// how reminders.go loads a *time.Location.
//
// ponytail: assumes fitness_config/fitness_goals exist at runtime. Before the
// human applies db/018 the SELECTs error — we log and continue, never crash.

// ---------- pure time predicates (unit-tested by fitnessCoachSelfCheck) ----------

// isPastCheckinTime reports whether now's wall-clock time-of-day is at/after the
// "HH:MM" checkin time. A malformed time is treated as "not yet" (never fires).
func isPastCheckinTime(now time.Time, checkin string) bool {
	if len(checkin) < 4 || checkin[2] != ':' {
		return false
	}
	h, err1 := strconv.Atoi(checkin[:2])
	m, err2 := strconv.Atoi(checkin[3:])
	if err1 != nil || err2 != nil || h < 0 || h > 23 || m < 0 || m > 59 {
		return false
	}
	return now.Hour()*60+now.Minute() >= h*60+m
}

// isSundayEvening reports whether now (already in the user's tz) is Sunday >= 19h.
func isSundayEvening(now time.Time) bool {
	return now.Weekday() == time.Sunday && now.Hour() >= 19
}

// sameLocalDay reports whether a and b fall on the same calendar day. Callers pass
// times already converted to the same *time.Location.
func sameLocalDay(a, b time.Time) bool {
	ay, am, ad := a.Date()
	by, bm, bd := b.Date()
	return ay == by && am == bm && ad == bd
}

func localDateStr(now time.Time) string { return now.Format("2006-01-02") }

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// fmtNum renders a float without a trailing ".0"/zeros (e.g. 5, 72.5).
func fmtNum(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }

// ---------- scheduler loop ----------

// startFitnessCoach launches the coaching ticker. main.go calls it once at boot,
// right next to startScheduler(pool).
func startFitnessCoach(pool *pgxpool.Pool) {
	go func() {
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			ctx, cancel := context.WithTimeout(context.Background(), 55*time.Second)
			if err := fitnessCoachTick(ctx, pool); err != nil {
				log.Printf("fitness coach: %v", err)
			}
			cancel()
		}
	}()
}

// fitnessCoachTick reads enabled configs (a short unlocked read) then coaches each
// user in its own tx. A per-user error is logged and skipped, never fatal to the
// loop.
func fitnessCoachTick(ctx context.Context, pool *pgxpool.Pool) error {
	rows, err := pool.Query(ctx, `SELECT user_id FROM fitness_config WHERE enabled = true`)
	if err != nil {
		return err // table missing (pre-migration) or DB down — logged by caller
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	for _, id := range ids {
		if err := coachUser(ctx, pool, id); err != nil {
			log.Printf("fitness coach: user %s: %v", id, err)
		}
		if err := nudgeGoals(ctx, pool, id); err != nil {
			log.Printf("fitness coach: goals for user %s: %v", id, err)
		}
	}
	return nil
}

// coachUser fires the check-in and weekly-summary actions inside one tx. The
// fitness_config row is claimed FOR UPDATE OF c SKIP LOCKED so a concurrent
// instance skips it (no double-send); the stamps make the next 60s tick idempotent.
func coachUser(ctx context.Context, pool *pgxpool.Pool, userID string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck — no-op after Commit

	var (
		checkin     string
		lastCheckin *time.Time
		lastWeekly  *time.Time
		tz          *string
	)
	err = tx.QueryRow(ctx, `
		SELECT c.checkin_time, c.last_checkin_at, c.last_weekly_at, u.timezone
		FROM fitness_config c
		JOIN users u ON u.id = c.user_id
		WHERE c.user_id = $1 AND c.enabled
		FOR UPDATE OF c SKIP LOCKED`, userID).Scan(&checkin, &lastCheckin, &lastWeekly, &tz)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil // disabled, gone, or locked by another instance
	}
	if err != nil {
		return err
	}
	if tz == nil || *tz == "" {
		return nil // no timezone => can't do local time math (set in Settings)
	}
	loc, err := time.LoadLocation(*tz)
	if err != nil {
		return fmt.Errorf("bad timezone %q: %w", *tz, err)
	}
	now := time.Now().In(loc)
	today := localDateStr(now)

	// Action 1 — evening check-in: past checkin_time, not already stamped today,
	// and no workout logged for local-today.
	if isPastCheckinTime(now, checkin) &&
		(lastCheckin == nil || !sameLocalDay(lastCheckin.In(loc), now)) {
		var n int
		if err := tx.QueryRow(ctx,
			`SELECT count(*) FROM workouts WHERE user_id = $1 AND performed_on = $2::date`,
			userID, today).Scan(&n); err != nil {
			return err
		}
		if n == 0 {
			const msg = "Evening check-in 💪 No workout logged yet today — even 15 min counts. What did you move today?"
			if _, err := tx.Exec(ctx,
				`INSERT INTO notifications (user_id, text) VALUES ($1, $2)`, userID, msg); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx,
				`UPDATE fitness_config SET last_checkin_at = now() WHERE user_id = $1`, userID); err != nil {
				return err
			}
		}
	}

	// Action 2 — Sunday-evening weekly summary: at most once per 24h.
	if isSundayEvening(now) && (lastWeekly == nil || now.Sub(*lastWeekly) > 24*time.Hour) {
		var count, streak int
		if err := tx.QueryRow(ctx,
			`SELECT count(*) FROM workouts
			 WHERE user_id = $1 AND performed_on >= date_trunc('week', $2::date)`,
			userID, today).Scan(&count); err != nil {
			return err
		}
		// Current streak = consecutive days ending on local-today (today-with-none => 0),
		// via gaps-and-islands so it's self-contained (no fitness.go dependency).
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM (
				SELECT (($2::date - performed_on)
				        - (row_number() OVER (ORDER BY performed_on DESC) - 1)) AS grp
				FROM (SELECT DISTINCT performed_on FROM workouts
				      WHERE user_id = $1 AND performed_on <= $2::date) d
			) x WHERE grp = 0`, userID, today).Scan(&streak); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO notifications (user_id, text) VALUES ($1, $2)`, userID, weeklyMsg(count, streak)); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`UPDATE fitness_config SET last_weekly_at = now() WHERE user_id = $1`, userID); err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}

func weeklyMsg(count, streak int) string {
	enc := "Solid effort — aim for one more next week!"
	switch {
	case count == 0:
		enc = "Fresh week ahead — let's get one on the board! 💪"
	case count >= 4:
		enc = "Strong week — keep the momentum going!"
	}
	streakPart := ""
	if streak > 0 {
		streakPart = fmt.Sprintf(" You're on a %d-day streak 🔥.", streak)
	}
	return fmt.Sprintf("Weekly wrap-up 📊 You logged %d workout%s this week.%s %s",
		count, plural(count), streakPart, enc)
}

// nudgeGoals fires per-goal deadline nudges for active goals due within 7 days,
// deduped to at most once per 3 days per goal. Rows are claimed FOR UPDATE SKIP
// LOCKED and drained before any write (one tx = one connection).
func nudgeGoals(ctx context.Context, pool *pgxpool.Pool, userID string) error {
	tz, err := userTZ(ctx, pool, userID)
	if err != nil || tz == "" {
		return err
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return fmt.Errorf("bad timezone %q: %w", tz, err)
	}
	today := localDateStr(time.Now().In(loc))

	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	rows, err := tx.Query(ctx, `
		SELECT id, title, target_value, current_value, coalesce(target_unit, ''),
		       (deadline - $2::date) AS days_left
		FROM fitness_goals
		WHERE user_id = $1 AND status = 'active' AND deadline IS NOT NULL
		  AND deadline BETWEEN $2::date AND $2::date + 7
		  AND (last_nudge_at IS NULL OR last_nudge_at < now() - interval '3 days')
		FOR UPDATE SKIP LOCKED`, userID, today)
	if err != nil {
		return err
	}
	type nudge struct {
		id, title, unit string
		target          float64
		current         *float64
		daysLeft        int
	}
	var due []nudge
	for rows.Next() {
		var g nudge
		if err := rows.Scan(&g.id, &g.title, &g.target, &g.current, &g.unit, &g.daysLeft); err != nil {
			rows.Close()
			return err
		}
		due = append(due, g)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	for _, g := range due {
		if _, err := tx.Exec(ctx,
			`INSERT INTO notifications (user_id, text) VALUES ($1, $2)`,
			userID, goalMsg(g.title, g.unit, g.target, g.current, g.daysLeft)); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`UPDATE fitness_goals SET last_nudge_at = now() WHERE id = $1`, g.id); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func goalMsg(title, unit string, target float64, current *float64, daysLeft int) string {
	cur := 0.0
	if current != nil {
		cur = *current
	}
	u := ""
	if unit != "" {
		u = " " + unit
	}
	due := fmt.Sprintf("in %d days", daysLeft)
	switch daysLeft {
	case 0:
		due = "today"
	case 1:
		due = "in 1 day"
	}
	return fmt.Sprintf("Goal check ⏰ \"%s\" is due %s — you're at %s/%s%s. You've got this! 💪",
		title, due, fmtNum(cur), fmtNum(target), u)
}

// userTZ reads users.timezone ("" if unset). Small helper so nudgeGoals doesn't
// depend on reminders.go's store method.
func userTZ(ctx context.Context, pool *pgxpool.Pool, userID string) (string, error) {
	var tz *string
	err := pool.QueryRow(ctx, `SELECT timezone FROM users WHERE id = $1`, userID).Scan(&tz)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil || tz == nil {
		return "", err
	}
	return *tz, nil
}

// ---------- self-check (pure predicates; no DB, no framework) ----------

// fitnessCoachSelfCheck asserts the pure time predicates. Run it from a throwaway
// caller (or a temporary _test.go) — it panics on the first wrong answer.
func fitnessCoachSelfCheck() {
	loc := time.UTC
	at := func(wd time.Weekday, h, m int) time.Time {
		// 2026-07-19 is a Sunday; walk to the requested weekday within that week.
		base := time.Date(2026, 7, 19, h, m, 0, 0, loc) // Sunday
		return base.AddDate(0, 0, int(wd)) // Sunday+wd
	}
	assert := func(cond bool, name string) {
		if !cond {
			panic("fitnessCoachSelfCheck FAILED: " + name)
		}
	}

	sun2000 := at(time.Sunday, 20, 0)
	// isPastCheckinTime
	assert(isPastCheckinTime(sun2000, "20:00"), "20:00 == 20:00 is past")
	assert(isPastCheckinTime(sun2000, "19:59"), "20:00 after 19:59")
	assert(!isPastCheckinTime(sun2000, "20:01"), "20:00 before 20:01")
	assert(!isPastCheckinTime(sun2000, "bad"), "malformed => not past")
	assert(!isPastCheckinTime(sun2000, "24:00"), "out-of-range hour => not past")

	// isSundayEvening
	assert(isSundayEvening(sun2000), "Sunday 20:00 is evening")
	assert(!isSundayEvening(at(time.Sunday, 18, 59)), "Sunday 18:59 not evening")
	assert(!isSundayEvening(at(time.Monday, 20, 0)), "Monday 20:00 not Sunday")

	// sameLocalDay
	assert(sameLocalDay(at(time.Sunday, 6, 0), at(time.Sunday, 23, 0)), "same Sunday")
	assert(!sameLocalDay(at(time.Sunday, 6, 0), at(time.Monday, 1, 0)), "Sun != Mon")

	// fmtNum
	assert(fmtNum(5) == "5" && fmtNum(72.5) == "72.5", "fmtNum trims zeros")
}
