package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
)

// loginApp mounts ONLY the public login surface (login-start, callback, session)
// so these tests do not depend on main.go's route registration landing.
func loginApp(s *Server) *fiber.App {
	app := fiber.New()
	app.Get("/auth/google/login", s.handleGoogleLoginStart)
	app.Get("/auth/google/callback", s.handleGoogleCallback)
	app.Get("/auth/session", s.handleSession)
	app.Post("/auth/logout", s.handleLogout)
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
// secret; on 200 it mints a DURABLE opaque session id into an httpOnly cookie
// (never a JWT, never in the URL) and 302s to ?login=ok; /auth/session RE-ISSUES
// a fresh short-lived access JWT on every call WITHOUT consuming the cookie (so a
// refresh persists); logout REVOKES the session server-side; and a 403 (uninvited)
// fails closed to ?login=denied.
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
		if !sc.Secure || sc.SameSite != http.SameSiteLaxMode {
			t.Fatalf("session cookie must be Secure + SameSite=Lax, got secure=%v samesite=%v", sc.Secure, sc.SameSite)
		}
		if sc.MaxAge < 6*24*3600 {
			t.Fatalf("session cookie Max-Age = %ds, want ~7d (durable)", sc.MaxAge)
		}
		// The cookie is an OPAQUE session id, NOT a JWT — parseToken must reject it.
		if _, _, err := srv.parseToken(sc.Value); err == nil {
			t.Fatal("session cookie must be an opaque id, not a decodable JWT")
		}
		sessionCookie = sc.Value
	}

	// RE-ISSUE: /auth/session mints a short-lived access JWT and does NOT consume
	// the cookie. Called twice with the same cookie -> both 200 with a valid token
	// and the cookie still intact. This is what makes a page refresh restore the
	// session. (Tokens minted within the same second are byte-identical by design —
	// iat/exp are second-resolution — so we assert validity, not distinctness.)
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodGet, "/auth/session", nil)
		req.AddCookie(&http.Cookie{Name: cfg.SessionCookieName, Value: sessionCookie})
		resp, err := app.Test(req, 5000)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != 200 {
			t.Fatalf("session call %d = %d, want 200 (cookie must NOT be consumed)", i, resp.StatusCode)
		}
		var out struct {
			Token string `json:"token"`
			Role  string `json:"role"`
			User  struct {
				ID string `json:"id"`
			} `json:"user"`
		}
		json.NewDecoder(resp.Body).Decode(&out)
		// The returned token is a fresh access JWT, not the raw cookie.
		sub, role, err := srv.parseToken(out.Token)
		if err != nil || sub != wantUID || role != "member" {
			t.Fatalf("session token = (%q,%q,%v), want (%q,member,nil)", sub, role, err, wantUID)
		}
		if out.Role != "member" || out.User.ID != wantUID {
			t.Fatalf("session payload = %+v, want member+%s", out, wantUID)
		}
		if out.Token == sessionCookie {
			t.Fatal("session returned the raw cookie as the token; must be a minted JWT")
		}
		// The cookie must NOT be cleared on read (unlike the old one-time handoff).
		for _, ck := range resp.Cookies() {
			if ck.Name == cfg.SessionCookieName && ck.Value == "" {
				t.Fatal("/auth/session consumed/cleared the durable cookie; refresh would fail")
			}
		}
	}

	// Empty cookie -> 401.
	{
		resp, _ := app.Test(httptest.NewRequest(http.MethodGet, "/auth/session", nil), 5000)
		if resp.StatusCode != 401 {
			t.Fatalf("no-cookie session = %d, want 401", resp.StatusCode)
		}
	}

	// LOGOUT revokes server-side: POST /auth/logout -> 200; the same cookie then
	// 401s at /auth/session (session gone from Redis).
	{
		req := httptest.NewRequest(http.MethodPost, "/auth/logout", nil)
		req.AddCookie(&http.Cookie{Name: cfg.SessionCookieName, Value: sessionCookie})
		resp, err := app.Test(req, 5000)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != 200 {
			t.Fatalf("logout = %d, want 200", resp.StatusCode)
		}
		req2 := httptest.NewRequest(http.MethodGet, "/auth/session", nil)
		req2.AddCookie(&http.Cookie{Name: cfg.SessionCookieName, Value: sessionCookie})
		resp2, _ := app.Test(req2, 5000)
		if resp2.StatusCode != 401 {
			t.Fatalf("session after logout = %d, want 401 (revoked)", resp2.StatusCode)
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
