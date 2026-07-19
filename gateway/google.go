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
	payload, err := base64.RawURLEncoding.DecodeString(p)
	if err != nil {
		return "", false
	}
	gotMAC, err := base64.RawURLEncoding.DecodeString(sig)
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

	q := url.Values{}
	q.Set("client_id", s.cfg.GoogleClientID)
	q.Set("redirect_uri", s.cfg.GoogleRedirectURI)
	q.Set("response_type", "code")
	q.Set("scope", googleScopes)
	q.Set("access_type", "offline")
	q.Set("prompt", "consent")
	q.Set("include_granted_scopes", "true")
	q.Set("state", state)

	return c.JSON(fiber.Map{
		"auth_url": "https://accounts.google.com/o/oauth2/v2/auth?" + q.Encode(),
	})
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
