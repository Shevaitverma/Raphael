package main

import (
	"testing"
	"time"
)

// parseLocalTime must read the tool's naive ISO-8601 as WALL-CLOCK in the user's
// tz (not UTC), so the fire lands at the intended local instant. A wrong reading
// silently shifts every fire by the tz offset — hence this check.
func TestParseLocalTime(t *testing.T) {
	kolkata, err := time.LoadLocation("Asia/Kolkata") // +05:30, exercises tzdata
	if err != nil {
		t.Fatalf("LoadLocation: %v", err)
	}

	// naive "17:00" in Kolkata == 11:30 UTC.
	got, err := parseLocalTime("2026-07-23T17:00", kolkata)
	if err != nil {
		t.Fatalf("parse naive: %v", err)
	}
	if want := time.Date(2026, 7, 23, 11, 30, 0, 0, time.UTC); !got.Equal(want) {
		t.Fatalf("naive local: got %s, want %s", got.UTC(), want)
	}

	// with seconds.
	if got, err = parseLocalTime("2026-07-23T17:00:30", kolkata); err != nil || got.Second() != 30 {
		t.Fatalf("with seconds: got %s err %v", got, err)
	}

	// an absolute RFC3339 (with offset) is honored as-is, not re-localized.
	got, err = parseLocalTime("2026-07-23T17:00:00Z", kolkata)
	if err != nil || !got.Equal(time.Date(2026, 7, 23, 17, 0, 0, 0, time.UTC)) {
		t.Fatalf("rfc3339: got %s err %v", got, err)
	}

	if _, err = parseLocalTime("not-a-time", kolkata); err == nil {
		t.Fatalf("expected error on garbage input")
	}
}
