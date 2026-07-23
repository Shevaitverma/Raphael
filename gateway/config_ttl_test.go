package main

import (
	"testing"
	"time"
)

// TestGetdurFailsClosed proves getdur never yields a zero/negative TTL, which
// would disable token/session expiry. Empty, garbage, and "0s" must all fall
// back to the default; a valid duration must pass through.
func TestGetdurFailsClosed(t *testing.T) {
	const key = "ACCESS_TTL_TEST_ONLY"
	def := time.Hour

	cases := map[string]time.Duration{
		"":       def,             // unset -> default
		"bogus":  def,             // unparseable -> default
		"0s":     def,             // zero -> default (never disable expiry)
		"-5m":    def,             // negative -> default
		"30m":    30 * time.Minute, // valid -> passthrough
		"168h":   168 * time.Hour,  // valid 7d -> passthrough
	}
	for in, want := range cases {
		t.Setenv(key, in)
		if in == "" {
			t.Setenv(key, "") // Setenv can't unset; "" is the empty path anyway
		}
		if got := getdur(key, def); got != want {
			t.Errorf("getdur(%q)=%v, want %v", in, got, want)
		}
	}
}
