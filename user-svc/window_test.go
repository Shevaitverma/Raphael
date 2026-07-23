package main

import (
	"testing"
	"time"
)

// windowEnd is pure; assert it derives the tz-correct end for each category so
// "every hour today" reliably stops at end of day even when the model omits until.
func TestWindowEnd(t *testing.T) {
	loc, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		t.Fatalf("load tz: %v", err)
	}
	now := time.Now().In(loc)

	today := windowEnd("today", loc)
	if today == nil {
		t.Fatal(`"today" -> nil`)
	}
	if today.Year() != now.Year() || today.Month() != now.Month() || today.Day() != now.Day() {
		t.Fatalf("today not the current date in tz: got %v, now %v", today, now)
	}
	if today.Hour() != 23 || today.Minute() != 59 {
		t.Fatalf("today not end-of-day 23:59: %v", today)
	}

	if wk := windowEnd("this_week", loc); wk == nil || wk.Weekday() != time.Sunday || wk.Hour() != 23 {
		t.Fatalf(`"this_week" should be a Sunday 23:59: %v`, wk)
	}

	if windowEnd("", loc) != nil {
		t.Fatal(`"" should be nil (no bound)`)
	}
	if windowEnd("someday", loc) != nil {
		t.Fatal("unknown window should be nil, not a spurious bound")
	}
}
