package main

import (
	"testing"
	"time"
)

// The three design examples, proven end to end (parse -> nextFire -> computeNext):
//   water: "every hour today"        -> "0 * * * *" with until = end of today
//   gym:   "daily, Sunday off"       -> "0 9 * * 1-6"
//   music: "every Mon and Tue"       -> "0 9 * * 1,2"
// UTC is used for slot assertions so DST never muddies the expected minute.

func mustLoc(t *testing.T, name string) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation(name)
	if err != nil {
		t.Fatalf("LoadLocation(%q): %v (tzdata not embedded?)", name, err)
	}
	return loc
}

func TestWaterHourlyBoundedToToday(t *testing.T) {
	loc := time.UTC
	// 2026-07-22 is a Wednesday. Start at 08:30; hourly slots are :00 each hour.
	now := time.Date(2026, 7, 22, 8, 30, 0, 0, loc)
	until := time.Date(2026, 7, 22, 23, 59, 59, 0, loc)

	nf, err := computeNext(now, "cron", "0 * * * *", nil, &until, "UTC", false)
	if err != nil {
		t.Fatal(err)
	}
	if want := time.Date(2026, 7, 22, 9, 0, 0, 0, loc); !nf.Equal(want) {
		t.Fatalf("first fire = %v, want %v", nf, want)
	}

	// Advance through the day: the last in-bounds slot is 23:00; the next slot
	// (tomorrow 00:00) is past `until`, so computeNext deactivates (nil).
	at2300 := time.Date(2026, 7, 22, 23, 0, 0, 0, loc)
	after, err := computeNext(at2300, "cron", "0 * * * *", nil, &until, "UTC", true)
	if err != nil {
		t.Fatal(err)
	}
	if after != nil {
		t.Fatalf("past `until` should deactivate, got %v", after)
	}
}

func TestGymDailyExceptSunday(t *testing.T) {
	loc := time.UTC
	sp, err := parseCron("0 9 * * 1-6")
	if err != nil {
		t.Fatal(err)
	}
	// Saturday 2026-07-25 07:00 -> today 09:00 fires (Sat is dow 6, in 1-6).
	sat := time.Date(2026, 7, 25, 7, 0, 0, 0, loc)
	nf, _ := nextFire(sat, sp, loc)
	if want := time.Date(2026, 7, 25, 9, 0, 0, 0, loc); !nf.Equal(want) {
		t.Fatalf("Saturday next = %v, want %v", nf, want)
	}
	// Saturday AFTER 09:00 -> Sunday is skipped -> Monday 2026-07-27 09:00.
	satPM := time.Date(2026, 7, 25, 10, 0, 0, 0, loc)
	nf2, _ := nextFire(satPM, sp, loc)
	if want := time.Date(2026, 7, 27, 9, 0, 0, 0, loc); !nf2.Equal(want) {
		t.Fatalf("skip-Sunday next = %v, want Monday %v", nf2, want)
	}
	if sp.matches(time.Date(2026, 7, 26, 9, 0, 0, 0, loc)) { // Sunday
		t.Fatal("Sunday must not match 1-6")
	}
}

func TestMusicMondayAndTuesday(t *testing.T) {
	loc := time.UTC
	sp, err := parseCron("0 9 * * 1,2")
	if err != nil {
		t.Fatal(err)
	}
	// Wednesday 2026-07-22 -> next match is Monday 2026-07-27 09:00.
	wed := time.Date(2026, 7, 22, 12, 0, 0, 0, loc)
	nf, _ := nextFire(wed, sp, loc)
	if want := time.Date(2026, 7, 27, 9, 0, 0, 0, loc); !nf.Equal(want) {
		t.Fatalf("Wed next = %v, want Monday %v", nf, want)
	}
	// From Monday 09:00, the next is Tuesday 09:00 (both weekdays fire).
	mon := time.Date(2026, 7, 27, 9, 0, 0, 0, loc)
	nf2, _ := nextFire(mon, sp, loc)
	if want := time.Date(2026, 7, 28, 9, 0, 0, 0, loc); !nf2.Equal(want) {
		t.Fatalf("Mon->next = %v, want Tuesday %v", nf2, want)
	}
	for _, dow := range []int{0, 3, 4, 5, 6} { // Sun, Wed..Sat must not match
		d := time.Date(2026, 7, 20, 9, 0, 0, 0, loc).AddDate(0, 0, dowOffset(dow))
		if sp.matches(d) {
			t.Fatalf("dow %d should not match 1,2", dow)
		}
	}
}

// dowOffset maps a target weekday (0=Sun) to a day offset from 2026-07-20 (Monday).
func dowOffset(dow int) int {
	if dow == 0 {
		return 6 // Sunday is 6 days after Monday
	}
	return dow - 1
}

func TestCatchUpCollapsesMissedSlots(t *testing.T) {
	loc := time.UTC
	// Hourly reminder due at 09:00 but the worker was down until 15:20. Advancing
	// with now=15:20 must jump to 16:00 (one catch-up), not replay 10:00..15:00.
	now := time.Date(2026, 7, 22, 15, 20, 0, 0, loc)
	nf, err := computeNext(now, "cron", "0 * * * *", nil, nil, "UTC", true)
	if err != nil {
		t.Fatal(err)
	}
	if want := time.Date(2026, 7, 22, 16, 0, 0, 0, loc); !nf.Equal(want) {
		t.Fatalf("catch-up next = %v, want %v (no missed-slot replay)", nf, want)
	}
}

func TestOnceFiresThenDeactivates(t *testing.T) {
	fireAt := time.Date(2026, 7, 22, 17, 0, 0, 0, time.UTC)
	now := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)

	initial, err := computeNext(now, "once", "", &fireAt, nil, "UTC", false)
	if err != nil {
		t.Fatal(err)
	}
	if initial == nil || !initial.Equal(fireAt) {
		t.Fatalf("initial once = %v, want %v", initial, fireAt)
	}
	after, err := computeNext(fireAt, "once", "", &fireAt, nil, "UTC", true)
	if err != nil {
		t.Fatal(err)
	}
	if after != nil {
		t.Fatalf("once after firing should deactivate, got %v", after)
	}
	if _, err := computeNext(now, "once", "", nil, nil, "UTC", false); err == nil {
		t.Fatal("once without fireAt must error (missing-schedule guard)")
	}
}

func TestTimezoneIsHonored(t *testing.T) {
	// 0 9 * * * at 08:30 IST -> 09:00 IST == 03:30 UTC.
	ist := mustLoc(t, "Asia/Kolkata")
	now := time.Date(2026, 7, 22, 8, 30, 0, 0, ist)
	nf, err := computeNext(now, "cron", "0 9 * * *", nil, nil, "Asia/Kolkata", false)
	if err != nil {
		t.Fatal(err)
	}
	wantUTC := time.Date(2026, 7, 22, 3, 30, 0, 0, time.UTC)
	if !nf.Equal(wantUTC) {
		t.Fatalf("IST 09:00 = %v UTC, want %v", nf.UTC(), wantUTC)
	}
}

func TestStepAndRangeParsing(t *testing.T) {
	sp, err := parseCron("*/15 * * * *") // every 15 min
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range []int{0, 15, 30, 45} {
		if !sp.min.contains(m) {
			t.Fatalf("*/15 should contain minute %d", m)
		}
	}
	if sp.min.contains(10) {
		t.Fatal("*/15 should not contain minute 10")
	}
	if _, err := parseCron("bad cron"); err == nil {
		t.Fatal("wrong field count must error")
	}
	if _, err := parseCron("0 99 * * *"); err == nil {
		t.Fatal("out-of-range hour must error")
	}
}
