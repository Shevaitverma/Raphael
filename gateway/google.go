package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
)

// googleScopes is the FROZEN No-CASA scope set: identity + Calendar read-only.
// Anything more (write, Gmail, Drive) would trip Google's CASA security review.
const googleScopes = "openid email profile https://www.googleapis.com/auth/calendar.readonly"

// loginSentinel is the state marker that tells the (single) callback this is a
// LOGIN, not a re-consent. It is signed into the state exactly like a uid, so
// verifyState's HMAC+exp guarantees still hold (CSRF unchanged). A real uid is
// always a uuid, so "login" can never collide with one, and forging this marker
// needs the JWT secret — no new trust boundary.
const loginSentinel = "login"

// statePayload is what the signed state carries THROUGH Google. The callback has
// no JWT, so `uid` is the authenticated assertion — trusted only after the HMAC
// verifies. `exp` bounds replay; `nonce` makes each state unique.
type statePayload struct {
	UID   string `json:"uid"`
	Exp   int64  `json:"exp"`
	Nonce string `json:"nonce"`
}

// signState produces  base64url(payload) + "." + base64url(HMAC-SHA256(payload,
// JWT_SECRET)). Reusing JWT_SECRET is deliberate: it is the SAME trust boundary
// as internal.go's shared secret — anyone who could forge this could already
// forge a JWT. Without the secret an attacker can neither forge a uid nor mint a
// fresh exp, so the callback can safely trust a verified state with no JWT.
func (s *Server) signState(uid string) (string, error) {
	nb := make([]byte, 16)
	if _, err := rand.Read(nb); err != nil {
		return "", err
	}
	payload, err := json.Marshal(statePayload{
		UID:   uid,
		Exp:   time.Now().Add(10 * time.Minute).Unix(),
		Nonce: base64.RawURLEncoding.EncodeToString(nb),
	})
	if err != nil {
		return "", err
	}
	p := base64.RawURLEncoding.EncodeToString(payload)
	return p + "." + base64.RawURLEncoding.EncodeToString(s.stateMAC(payload)), nil
}

// stateMAC is the HMAC-SHA256 of the raw payload bytes under JWT_SECRET.
func (s *Server) stateMAC(payload []byte) []byte {
	m := hmac.New(sha256.New, []byte(s.cfg.JWTSecret))
	m.Write(payload)
	return m.Sum(nil)
}

// verifyState is the CSRF + identity boundary. It recomputes the HMAC over the
// payload and compares it CONSTANT-TIME (crypto/subtle) — a timing-safe compare
// so the MAC can't be brute-forced byte by byte — then rejects an expired state.
// Only then is uid trusted. A flipped byte anywhere fails the MAC; a stale state
// fails the exp check. Returns ok=false on any defect; the caller must not 302
// success and must not call user-svc when ok is false.
func (s *Server) verifyState(state string) (uid string, ok bool) {
	p, sig, found := strings.Cut(state, ".")
	if !found {
		return "", false
	}
	// Strict() rejects non-canonical trailing bits. signState always emits
	// canonical base64, so this only ever rejects a TAMPERED token: without it, the
	// MAC's final base64 char carries unused padding bits, and Go's lenient decoder
	// would map a flipped-padding char back to the SAME bytes — letting an attacker
	// mutate the CSRF state into an equivalent form. Canonical-only closes that.
	enc := base64.RawURLEncoding.Strict()
	payload, err := enc.DecodeString(p)
	if err != nil {
		return "", false
	}
	gotMAC, err := enc.DecodeString(sig)
	if err != nil {
		return "", false
	}
	if subtle.ConstantTimeCompare(gotMAC, s.stateMAC(payload)) != 1 {
		return "", false
	}
	var sp statePayload
	if err := json.Unmarshal(payload, &sp); err != nil {
		return "", false
	}
	if sp.UID == "" || time.Now().Unix() >= sp.Exp {
		return "", false
	}
	return sp.UID, true
}

// handleGoogleConnect (GET /api/google/connect, JWT-gated) returns the Google
// consent URL as JSON — NOT a 302 — so the web can fetch it with its Bearer
// token and then window.location itself, keeping the JWT out of the browser URL.
// The uid comes from the JWT and is sealed into the signed state. Fails closed
// with 503 when Google is unconfigured (never panics).
func (s *Server) handleGoogleConnect(c *fiber.Ctx) error {
	if s.cfg.GoogleClientID == "" {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"error": "google not configured"})
	}
	uid := c.Locals(userIDKey).(string)
	state, err := s.signState(uid)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "could not build auth url")
	}
	return c.JSON(fiber.Map{"auth_url": s.consentURL(state)})
}

// consentURL builds the Google consent URL for a signed state. Shared by connect
// (re-consent, uid state) and login-start (loginSentinel state) so the frozen
// scope set + offline/consent params live in ONE place — a scope drift here
// would silently change both flows.
func (s *Server) consentURL(state string) string {
	q := url.Values{}
	q.Set("client_id", s.cfg.GoogleClientID)
	q.Set("redirect_uri", s.cfg.GoogleRedirectURI)
	q.Set("response_type", "code")
	q.Set("scope", googleScopes)
	q.Set("access_type", "offline")
	q.Set("prompt", "consent")
	q.Set("include_granted_scopes", "true")
	q.Set("state", state)
	return "https://accounts.google.com/o/oauth2/v2/auth?" + q.Encode()
}

// handleGoogleLoginStart (GET /auth/google/login, PUBLIC, NO JWT) begins Google
// Sign-In AS the login. It has no caller identity yet, so the state carries the
// loginSentinel marker instead of a uid; the callback branches on it. Returns
// the consent URL as JSON (never a 302) so the browser navigates itself and no
// value ever rides a redirect. Fails closed with 503 when Google is unconfigured.
func (s *Server) handleGoogleLoginStart(c *fiber.Ctx) error {
	if s.cfg.GoogleClientID == "" {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"error": "google not configured"})
	}
	state, err := s.signState(loginSentinel)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "could not build auth url")
	}
	return c.JSON(fiber.Map{"auth_url": s.consentURL(state)})
}

// handleGoogleCallback (GET /auth/google/callback, PUBLIC, NO JWT) is where
// Google redirects the browser. It has no JWT — the signed state IS the
// authenticated identity. Verify it, forward the code to user-svc's internal
// exchange with the shared secret, then 302 to WEB_ORIGIN. Any failure (bad
// state, missing code, upstream error) redirects to ?google=error. A token
// NEVER appears in the redirect URL.
func (s *Server) handleGoogleCallback(c *fiber.Ctx) error {
	fail := func() error {
		return c.Redirect(s.cfg.WebOrigin+"/?google=error", fiber.StatusFound)
	}

	code := c.Query("code")
	uid, ok := s.verifyState(c.Query("state"))
	if code == "" || !ok {
		return fail()
	}

	// LOGIN branch: the state carried the sentinel, so this is Google Sign-In as
	// the login. Authenticate via user-svc (RBAC gate lives there) and hand the
	// SPA a session — the JWT never rides the redirect URL.
	if uid == loginSentinel {
		return s.handleLoginExchange(c, code)
	}

	// Otherwise a real uid: legacy re-consent that attaches calendar to an
	// already-logged-in user. Unchanged.
	body, _ := json.Marshal(map[string]string{"code": code})
	target := s.cfg.UserSvcURL + "/internal/users/" + uid + "/google/exchange"
	req, err := http.NewRequestWithContext(c.Context(), http.MethodPost, target, strings.NewReader(string(body)))
	if err != nil {
		return fail()
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", s.cfg.InternalToken)

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return fail()
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fail()
	}
	return c.Redirect(s.cfg.WebOrigin+"/?google=connected", fiber.StatusFound)
}

// handleLoginExchange runs the LOGIN branch of the callback. It forwards the
// code to user-svc's /internal/google/login (which owns the RBAC gate:
// bootstrap-admin / allowlisted-member / reject) and, on success, mints a
// role-bearing JWT and drops it into a short-lived httpOnly cookie. The browser
// never sees the token in a URL — it exchanges the cookie for in-memory state
// via /auth/session. Fail closed: an uninvited email (403) redirects to
// ?login=denied and NOTHING is stored; any other upstream failure -> ?login=error.
func (s *Server) handleLoginExchange(c *fiber.Ctx, code string) error {
	body, _ := json.Marshal(map[string]string{"code": code})
	target := s.cfg.UserSvcURL + "/internal/google/login"
	req, err := http.NewRequestWithContext(c.Context(), http.MethodPost, target, strings.NewReader(string(body)))
	if err != nil {
		return c.Redirect(s.cfg.WebOrigin+"/?login=error", fiber.StatusFound)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", s.cfg.InternalToken)

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return c.Redirect(s.cfg.WebOrigin+"/?login=error", fiber.StatusFound)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusForbidden {
		// Uninvited -> rejected at the callback (fail closed). No session issued.
		return c.Redirect(s.cfg.WebOrigin+"/?login=denied", fiber.StatusFound)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return c.Redirect(s.cfg.WebOrigin+"/?login=error", fiber.StatusFound)
	}

	var out struct {
		UID  string `json:"uid"`
		Role string `json:"role"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || out.UID == "" {
		return c.Redirect(s.cfg.WebOrigin+"/?login=error", fiber.StatusFound)
	}

	token, err := s.mintToken(out.UID, out.Role)
	if err != nil {
		return c.Redirect(s.cfg.WebOrigin+"/?login=error", fiber.StatusFound)
	}

	// One-time handoff cookie: httpOnly (JS can't read it), Secure, SameSite=Lax
	// (survives the top-level redirect back from Google), short TTL. The SPA
	// immediately trades it for in-memory state at /auth/session, so it never
	// lands in localStorage or a URL.
	c.Cookie(&fiber.Cookie{
		Name:     s.cfg.SessionCookieName,
		Value:    token,
		Path:     "/",
		HTTPOnly: true,
		Secure:   true,
		SameSite: "Lax",
		MaxAge:   120,
	})
	return c.Redirect(s.cfg.WebOrigin+"/?login=ok", fiber.StatusFound)
}

// handleSession (GET /auth/session, PUBLIC, uses the credential cookie) is the
// one-time handoff: it reads the httpOnly session cookie set by the login
// callback, returns {token,user,role} as JSON for the SPA to hold in memory,
// and immediately EXPIRES the cookie so the JWT never persists in the browser.
// Missing/invalid cookie -> 401 (no session to hand off).
func (s *Server) handleSession(c *fiber.Ctx) error {
	raw := c.Cookies(s.cfg.SessionCookieName)
	if raw == "" {
		return fiber.NewError(fiber.StatusUnauthorized, "no session")
	}
	sub, role, err := s.parseToken(raw)
	if err != nil {
		// Stale/forged cookie: clear it and refuse.
		s.expireSession(c)
		return fiber.NewError(fiber.StatusUnauthorized, "invalid session")
	}
	s.expireSession(c) // one-time: consume the cookie on read
	return c.JSON(fiber.Map{
		"token": raw,
		"role":  role,
		"user":  fiber.Map{"id": sub},
	})
}

// expireSession clears the session cookie (same attributes, past expiry).
func (s *Server) expireSession(c *fiber.Ctx) {
	c.Cookie(&fiber.Cookie{
		Name:     s.cfg.SessionCookieName,
		Value:    "",
		Path:     "/",
		HTTPOnly: true,
		Secure:   true,
		SameSite: "Lax",
		Expires:  time.Now().Add(-time.Hour),
		MaxAge:   -1,
	})
}

// proxyGoogle handles GET /api/google/status and DELETE /api/google. Same
// machinery as proxyProviders/proxyProfile: the target is ALWAYS rooted at
// /users/<jwt-uid>/google, so the uid comes from the JWT and user-svc's
// /internal/* stays unreachable through this route.
//
// GET    /api/google/status → GET    /users/<uid>/google/status
// DELETE /api/google        → DELETE /users/<uid>/google
func (s *Server) proxyGoogle(c *fiber.Ctx) error {
	uid := c.Locals(userIDKey).(string)

	rest := strings.TrimPrefix(c.Path(), "/api/google")
	if strings.Contains(rest, "..") || strings.Contains(strings.ToLower(rest), "internal") {
		return fiber.NewError(fiber.StatusBadRequest, "invalid path")
	}
	target := s.cfg.UserSvcURL + "/users/" + uid + "/google" + rest

	var body []byte
	if len(c.Body()) > 0 {
		body = c.Body()
	}
	return s.forward(c, c.Method(), target, body)
}
