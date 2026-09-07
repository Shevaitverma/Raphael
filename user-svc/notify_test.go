package main

import (
	"strings"
	"testing"
	"time"
)

// The subject line of an email is written by whoever sent it. If it reaches
// Telegram unescaped, at best the alert fails to parse and is lost; at worst the
// sender controls the formatting of a message the user trusts.
func TestRenderTelegramHTMLEscapesEverything(t *testing.T) {
	hostile := `<b>URGENT</b> & <a href="evil">click</a> <script>x</script>`
	got := renderTelegramHTML(hostile, "")

	if strings.Contains(got, "<script>") || strings.Contains(got, `href="evil"`) {
		t.Fatalf("attacker markup survived: %q", got)
	}
	for _, want := range []string{"&lt;b&gt;", "&amp;", "&lt;script&gt;"} {
		if !strings.Contains(got, want) {
			t.Errorf("expected %q in %q", want, got)
		}
	}
	// our own bold wrapper is the ONLY markup present
	if !strings.HasPrefix(got, "<b>") || strings.Count(got, "<b>") != 1 {
		t.Errorf("unexpected markup: %q", got)
	}
}

func TestRenderTelegramHTMLBody(t *testing.T) {
	got := renderTelegramHTML("Payment due\nFrom: CRED\nAmount: 18,450",
		"https://mail.google.com/mail/u/0/#inbox/abc")
	if !strings.HasPrefix(got, "<b>Payment due</b>") {
		t.Errorf("first line must be the push preview: %q", got)
	}
	if !strings.Contains(got, "Open in Gmail") {
		t.Errorf("missing link: %q", got)
	}
}

// A link column is exactly the sort of thing a later feature populates from
// somewhere less careful, so the scheme check is not decoration.
func TestRenderTelegramHTMLRejectsUnsafeURL(t *testing.T) {
	for _, bad := range []string{"javascript:alert(1)", "data:text/html,x", "ftp://x", ""} {
		if strings.Contains(renderTelegramHTML("hi", bad), "Open in Gmail") {
			t.Errorf("unsafe url rendered as a link: %q", bad)
		}
	}
}

func TestRenderTelegramHTMLTruncates(t *testing.T) {
	got := renderTelegramHTML(strings.Repeat("x", 9000), "")
	if len([]rune(got)) > telegramMaxChars+64 {
		t.Errorf("not truncated: %d runes", len([]rune(got)))
	}
}

// Quiet hours wrap midnight in every real configuration, which is the case a
// naive start<=now<end comparison gets wrong.
func TestInQuietHoursWrapsMidnight(t *testing.T) {
	at := func(h, m int) time.Time { return time.Date(2026, 8, 18, h, m, 0, 0, time.UTC) }

	cases := []struct {
		name       string
		now        time.Time
		start, end string
		want       bool
	}{
		{"late evening inside", at(23, 30), "22:00", "07:00", true},
		{"small hours inside", at(3, 0), "22:00", "07:00", true},
		{"exactly start", at(22, 0), "22:00", "07:00", true},
		{"exactly end is awake", at(7, 0), "22:00", "07:00", false},
		{"midday outside", at(12, 0), "22:00", "07:00", false},
		{"non-wrapping window inside", at(13, 0), "12:00", "14:00", true},
		{"non-wrapping window outside", at(15, 0), "12:00", "14:00", false},
		{"empty window disables", at(3, 0), "00:00", "00:00", false},
		{"malformed disables", at(3, 0), "garbage", "07:00", false},
	}
	for _, c := range cases {
		if got := inQuietHours(c.now, "UTC", c.start, c.end); got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}

// The window is the USER'S evening, not the server's.
func TestInQuietHoursUsesUserTimezone(t *testing.T) {
	// 18:00 UTC is 23:30 in Asia/Kolkata — quiet there, not quiet in UTC.
	utcEvening := time.Date(2026, 8, 18, 18, 0, 0, 0, time.UTC)
	if inQuietHours(utcEvening, "UTC", "22:00", "07:00") {
		t.Error("18:00 UTC should not be quiet in UTC")
	}
	if !inQuietHours(utcEvening, "Asia/Kolkata", "22:00", "07:00") {
		t.Error("18:00 UTC is 23:30 IST and should be quiet")
	}
	// an unknown zone must fall back, never panic
	_ = inQuietHours(utcEvening, "Not/AZone", "22:00", "07:00")
}

func TestBackoffForIsCapped(t *testing.T) {
	if got := backoffFor(0); got != time.Second {
		t.Errorf("first retry = %v, want 1s", got)
	}
	if got := backoffFor(3); got != 8*time.Second {
		t.Errorf("fourth retry = %v, want 8s", got)
	}
	for _, n := range []int{10, 40, 63, 64, 100} {
		if got := backoffFor(n); got != 5*time.Minute {
			t.Errorf("backoffFor(%d) = %v, want the 5m cap (overflow guard)", n, got)
		}
	}
}
