package main

import "testing"

// The mail worker gates on the scope Google ACTUALLY granted, so a false
// positive here would send it into a 403 loop against a Calendar-only grant,
// and a false negative would keep it inert for a user who has connected fine.
//
// The prefix cases are the ones worth pinning: gmail.modify.restricted and
// gmail.metadata both share a prefix with the scope we want but grant something
// different (org-wide admin modify, and headers-without-bodies respectively).
// strings.HasPrefix here would be a real vulnerability, not a style nit.
func TestHasMailScope(t *testing.T) {
	cal := "https://www.googleapis.com/auth/calendar.readonly"

	cases := []struct {
		name   string
		scopes []string
		want   bool
	}{
		{"granted alongside calendar", []string{"openid", cal, gmailModifyScope}, true},
		{"granted alone", []string{gmailModifyScope}, true},
		{"calendar-only grant (the pre-Gmail user)", []string{"openid", "email", cal}, false},
		{"no scopes at all", []string{}, false},
		{"nil", nil, false},
		{"readonly is not enough to apply a label",
			[]string{"https://www.googleapis.com/auth/gmail.readonly"}, false},
		{"labels alone cannot modify a message",
			[]string{"https://www.googleapis.com/auth/gmail.labels"}, false},
		{"metadata shares a prefix but cannot read bodies",
			[]string{"https://www.googleapis.com/auth/gmail.metadata"}, false},
		{"the admin variant is a different grant",
			[]string{"https://www.googleapis.com/auth/gmail.modify.restricted"}, false},
		{"full access is not something we ever request",
			[]string{"https://mail.google.com/"}, false},
	}

	for _, c := range cases {
		if got := hasMailScope(c.scopes); got != c.want {
			t.Errorf("%s: hasMailScope(%v) = %v, want %v", c.name, c.scopes, got, c.want)
		}
	}
}
