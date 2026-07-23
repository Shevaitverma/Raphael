package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
)

// loginApp mounts ONLY the public login surface (login-start, callback, session)
// so these tests do not depend on main.go's route registration landing.
func loginApp(s *Server) *fiber.App {
	app := fiber.New()
	app.Get("/auth/google/login", s.handleGoogleLoginStart)
	app.Get("/auth/google/callback", s.handleGoogleCallback)
	app.Get("/auth/session", s.handleSession)
	return app
}

// TestGoogleLoginStart: fails closed (503) when Google is unconfigured; once
// configured returns a JSON auth_url whose state carries the loginSentinel and
// whose scope/params match the frozen consent set.
func TestGoogleLoginStart(t *testing.T) {
	// Unconfigured -> 503, never a panic.
	{
		cfg := testConfig("http://127.0.0.1:1", "http://127.0.0.1:1", "http://127.0.0.1:1")
		cfg.GoogleClientID = ""
		app := loginApp(newServerT(t, cfg))
		resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/auth/google/login", nil), 5000)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != 503 {
			t.Fatalf("unconfigured login-start = %d, want 503", resp.StatusCode)
		}
	}

	// Configured -> 200, auth_url state verifies to the login sentinel.
	cfg := testConfig("http://127.0.0.1:1", "http://127.0.0.1:1", "http://127.0.0.1:1")
	cfg.GoogleClientID = "test-client-id.apps.googleusercontent.com"
	srv := newServerT(t, cfg)
	app := loginApp(srv)

	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/auth/google/login", nil), 5000)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("login-start = %d, want 200", resp.StatusCode)
	}
	var out struct {
		AuthURL string `json:"auth_url"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	u, err := url.Parse(out.AuthURL)
	if err != nil {
		t.Fatalf("auth_url unparseable: %v", err)
	}
	q := u.Query()
	if q.Get("scope") != googleScopes {
		t.Fatalf("scope = %q, want frozen set", q.Get("scope"))
	}
	if q.Get("access_type") != "offline" || q.Get("prompt") != "consent" {
		t.Fatal("login consent url missing offline/consent params")
	}
	got, ok := srv.verifyState(q.Get("state"))
	if !ok || got != loginSentinel {
		t.Fatalf("login state = (%q,%v), want (%q,true)", got, ok, loginSentinel)
	}
}

// TestGoogleLoginCallback proves the LOGIN branch end to end: a valid sentinel
// state forwards the code to user-svc /internal/google/login with the shared
// secret; on 200 it mints a role JWT into an httpOnly session cookie (never in
// the URL) and 302s to ?login=ok; /auth/session then hands the token+role to the
// SPA and expires the cookie; and a 403 (uninvited) fails closed to ?login=denied.
func TestGoogleLoginCallback(t *testing.T) {
	const wantUID = "77777777-7777-7777-7777-777777777777"
	var status int32 = http.StatusOK
	var gotPath, gotCode, gotSecret string

	user := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotSecret = r.Header.Get("X-Internal-Token")
		var in map[string]string
		json.NewDecoder(r.Body).Decode(&in)
		gotCode = in["code"]
		if code := int(status); code != http.StatusOK {
			w.WriteHeader(code)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"uid":"` + wantUID + `","role":"member","email":"m@example.com"}`))
	}))
	defer user.Close()

	cfg := testConfig(user.URL, "http://127.0.0.1:1", "http://127.0.0.1:1")
	cfg.GoogleClientID = "test-client-id.apps.googleusercontent.com"
	srv := newServerT(t, cfg)
	app := loginApp(srv)

	state, err := srv.signState(loginSentinel)
	if err != nil {
		t.Fatalf("signState: %v", err)
	}

	// SUCCESS: 200 -> cookie + ?login=ok, no token in URL.
	var sessionCookie string
	{
		req := httptest.NewRequest(http.MethodGet,
			"/auth/google/callback?code=login-code&state="+url.QueryEscape(state), nil)
		resp, err := app.Test(req, 5000)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != 302 {
			t.Fatalf("login callback = %d, want 302", resp.StatusCode)
		}
		loc := resp.Header.Get("Location")
		if loc != cfg.WebOrigin+"/?login=ok" {
			t.Fatalf("Location = %q, want ?login=ok", loc)
		}
		if strings.Contains(loc, "token") || strings.Contains(loc, "login-code") {
			t.Fatalf("redirect leaked a secret: %q", loc)
		}
		if gotPath != "/internal/google/login" {
			t.Fatalf("user-svc path = %q, want /internal/google/login", gotPath)
		}
		if gotCode != "login-code" {
			t.Fatalf("forwarded code = %q, want login-code", gotCode)
		}
		if gotSecret != cfg.InternalToken {
			t.Fatalf("X-Internal-Token = %q, want %q", gotSecret, cfg.InternalToken)
		}
		var sc *http.Cookie
		for _, ck := range resp.Cookies() {
			if ck.Name == cfg.SessionCookieName {
				sc = ck
			}
		}
		if sc == nil || sc.Value == "" {
			t.Fatal("no session cookie set on successful login")
		}
		if !sc.HttpOnly {
			t.Fatal("session cookie must be httpOnly")
		}
		// The cookie must be a role-bearing JWT for the resolved uid.
		sub, role, err := srv.parseToken(sc.Value)
		if err != nil || sub != wantUID || role != "member" {
			t.Fatalf("cookie token = (%q,%q,%v), want (%q,member,nil)", sub, role, err, wantUID)
		}
		sessionCookie = sc.Value
	}

	// HANDOFF: /auth/session returns {token,user,role} and expires the cookie.
	{
		req := httptest.NewRequest(http.MethodGet, "/auth/session", nil)
		req.AddCookie(&http.Cookie{Name: cfg.SessionCookieName, Value: sessionCookie})
		resp, err := app.Test(req, 5000)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != 200 {
			t.Fatalf("session = %d, want 200", resp.StatusCode)
		}
		var out struct {
			Token string `json:"token"`
			Role  string `json:"role"`
			User  struct {
				ID string `json:"id"`
			} `json:"user"`
		}
		json.NewDecoder(resp.Body).Decode(&out)
		if out.Token != sessionCookie || out.Role != "member" || out.User.ID != wantUID {
			t.Fatalf("session payload = %+v, want token+member+%s", out, wantUID)
		}
		var cleared bool
		for _, ck := range resp.Cookies() {
			// Fiber clears by emitting a past `expires=` with an empty value.
			if ck.Name == cfg.SessionCookieName && ck.Value == "" &&
				!ck.Expires.IsZero() && ck.Expires.Before(time.Now()) {
				cleared = true
			}
		}
		if !cleared {
			t.Fatal("session did not expire the cookie on read")
		}
	}

	// Empty cookie -> 401.
	{
		resp, _ := app.Test(httptest.NewRequest(http.MethodGet, "/auth/session", nil), 5000)
		if resp.StatusCode != 401 {
			t.Fatalf("no-cookie session = %d, want 401", resp.StatusCode)
		}
	}

	// DENIED: user-svc 403 -> ?login=denied, no session cookie (fail closed).
	{
		status = http.StatusForbidden
		req := httptest.NewRequest(http.MethodGet,
			"/auth/google/callback?code=login-code&state="+url.QueryEscape(state), nil)
		resp, err := app.Test(req, 5000)
		if err != nil {
			t.Fatal(err)
		}
		if loc := resp.Header.Get("Location"); loc != cfg.WebOrigin+"/?login=denied" {
			t.Fatalf("denied Location = %q, want ?login=denied", loc)
		}
		for _, ck := range resp.Cookies() {
			if ck.Name == cfg.SessionCookieName && ck.Value != "" {
				t.Fatal("denied login still set a session cookie")
			}
		}
	}
}
