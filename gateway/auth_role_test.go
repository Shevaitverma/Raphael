package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
)

// TestDevLoginCarriesRole proves dev-login threads users.role into the JWT: a
// fresh throwaway user defaults to 'member' (fail-closed) and the minted token's
// role claim round-trips through parseToken.
func TestDevLoginCarriesRole(t *testing.T) {
	cfg := testConfig("http://127.0.0.1:1", "http://127.0.0.1:1", "http://127.0.0.1:1")
	s := newServerT(t, cfg)
	app := s.BuildApp()

	email := fmt.Sprintf("auth-verify+role-%d@raphael.test", time.Now().UnixNano())
	token, uid := loginRole(t, app, email)
	defer deleteThrowaway(t, s, uid)

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
	_, uid := loginRole(t, s.BuildApp(), email) // user starts as 'member'
	defer deleteThrowaway(t, s, uid)

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

func loginRole(t *testing.T, app *fiber.App, email string) (token, uid string) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"email": email})
	req := httptest.NewRequest(http.MethodPost, "/auth/dev-login", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req, 5000)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("dev-login: err=%v status=%d", err, resp.StatusCode)
	}
	var out struct {
		Token string `json:"token"`
		User  User   `json:"user"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	if out.Token == "" || out.User.ID == "" {
		t.Fatalf("dev-login empty: %+v", out)
	}
	return out.Token, out.User.ID
}

// deleteThrowaway removes ONLY the auth-verify+* test user (invariant: never
// touch DEV_UID or real rows).
func deleteThrowaway(t *testing.T, s *Server, uid string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := s.db.Exec(ctx, `DELETE FROM users WHERE id=$1 AND email LIKE 'auth-verify+%@raphael.test'`, uid); err != nil {
		t.Logf("cleanup throwaway %s: %v", uid, err)
	}
}
