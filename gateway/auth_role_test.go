package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
)

// TestMintedTokenCarriesRole proves users.role threads into the JWT: a fresh
// user defaults to 'member' (fail-closed) and the minted token's role claim
// round-trips through parseToken.
func TestMintedTokenCarriesRole(t *testing.T) {
	cfg := testConfig("http://127.0.0.1:1", "http://127.0.0.1:1", "http://127.0.0.1:1")
	s := newServerT(t, cfg)

	email := fmt.Sprintf("auth-verify+role-%d@raphael.test", time.Now().UnixNano())
	token, uid := login(t, s, email)

	sub, role, err := s.parseToken(token)
	if err != nil {
		t.Fatalf("parseToken: %v", err)
	}
	if sub != uid {
		t.Fatalf("sub = %q, want %q", sub, uid)
	}
	if role != "member" {
		t.Fatalf("new user role = %q, want 'member' (fail-closed default)", role)
	}
}

// TestRequireAdminReReadsDB is the security core: requireAdmin must trust the DB,
// NEVER the JWT's role claim. A crafted 'admin' claim on a member row is rejected;
// a stale 'member' claim on an admin row is accepted — the claim is ignored both ways.
func TestRequireAdminReReadsDB(t *testing.T) {
	cfg := testConfig("http://127.0.0.1:1", "http://127.0.0.1:1", "http://127.0.0.1:1")
	s := newServerT(t, cfg)

	// Minimal app mounting requireAdmin behind authMiddleware (admin routes are
	// owned/mounted elsewhere; here we exercise the gate in isolation).
	app := fiber.New()
	app.Get("/admintest", s.authMiddleware, s.requireAdmin, func(c *fiber.Ctx) error {
		return c.SendString("ok")
	})

	email := fmt.Sprintf("auth-verify+admin-%d@raphael.test", time.Now().UnixNano())
	_, uid := login(t, s, email) // user starts as 'member'

	// (1) CRAFTED admin claim on a member DB row -> 403 (DB says member).
	forged, _ := s.mintToken(uid, "admin")
	if got := hitAdmin(t, app, forged); got != 403 {
		t.Fatalf("crafted admin claim on member row: status = %d, want 403", got)
	}

	// Promote the throwaway to admin in Postgres.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	if _, err := s.db.Exec(ctx, `UPDATE users SET role='admin' WHERE id=$1`, uid); err != nil {
		cancel()
		t.Fatalf("promote: %v", err)
	}
	cancel()

	// (2) STALE member claim on an admin DB row -> 200 (DB says admin).
	stale, _ := s.mintToken(uid, "member")
	if got := hitAdmin(t, app, stale); got != 200 {
		t.Fatalf("stale member claim on admin row: status = %d, want 200", got)
	}
}

func hitAdmin(t *testing.T, app *fiber.App, token string) int {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/admintest", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := app.Test(req, 5000)
	if err != nil {
		t.Fatalf("admintest request: %v", err)
	}
	return resp.StatusCode
}
