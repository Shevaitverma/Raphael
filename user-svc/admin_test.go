package main

import "testing"

// Pure validation for the admin surface — no DB, so it runs even when Postgres
// is unreachable. Guards the two decisions that gate the allowlist and roles.

func TestNormalizeEmail(t *testing.T) {
	cases := []struct {
		in     string
		want   string
		wantOK bool
	}{
		{"A@B.com", "a@b.com", true},
		{"  Foo@Bar.COM  ", "foo@bar.com", true},
		{"Display Name <a@b.com>", "a@b.com", true},
		{"", "", false},
		{"not-an-email", "", false},
		{"@nope.com", "", false},
		{"missing@", "", false},
	}
	for _, c := range cases {
		got, ok := normalizeEmail(c.in)
		if ok != c.wantOK || got != c.want {
			t.Errorf("normalizeEmail(%q) = %q,%v; want %q,%v", c.in, got, ok, c.want, c.wantOK)
		}
	}
}

func TestValidRole(t *testing.T) {
	for _, r := range []string{"admin", "member"} {
		if !validRole(r) {
			t.Errorf("validRole(%q) = false; want true", r)
		}
	}
	for _, r := range []string{"", "Admin", "owner", "root", "ADMIN"} {
		if validRole(r) {
			t.Errorf("validRole(%q) = true; want false", r)
		}
	}
}
