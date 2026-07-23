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

// mergePending: pending invites surface once; an active user is never
// double-listed even when their email is also on the allowlist (any case).
func TestMergePending(t *testing.T) {
	active := []adminUser{{Email: "Alice@x.com", Status: "active"}}
	pending := []allowlistEntry{
		{Email: "bob@x.com"},   // no user -> should surface as pending
		{Email: "ALICE@x.com"}, // matches active (case-insensitive) -> must NOT be added
	}
	out := mergePending(active, pending)
	if len(out) != 2 {
		t.Fatalf("len(out) = %d; want 2 (1 active + 1 pending)", len(out))
	}
	if out[0].Email != "Alice@x.com" || out[0].Status != "active" {
		t.Errorf("out[0] = %+v; want active Alice", out[0])
	}
	if out[1].Email != "bob@x.com" || out[1].Status != "pending" {
		t.Errorf("out[1] = %+v; want pending bob", out[1])
	}
}
