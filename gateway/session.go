package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"time"

	"github.com/gofiber/fiber/v2"
)

// sessionPrefix namespaces the durable session keys in Redis. The opaque id in
// the httpOnly cookie is the Redis key suffix; the value maps it to user + role.
// Reuses the Redis client already wired for rate limiting — no new dependency.
const sessionPrefix = "session:"

// sessionData is what a durable session id resolves to. Role is a UI hint only —
// requireAdmin re-reads users.role from Postgres on every privileged mutation, so
// a stale role here never grants authority.
type sessionData struct {
	UID  string `json:"uid"`
	Role string `json:"role"`
}

// createSession mints a random OPAQUE session id (not a JWT), stores {uid,role}
// in Redis under session:<id> with SessionTTL expiry, and returns the id. The id
// is what rides the durable cookie, so the session is revocable server-side (a
// DEL kills it) — the standard, and why we prefer this over a raw long-lived JWT.
func (s *Server) createSession(ctx context.Context, uid, role string) (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	id := base64.RawURLEncoding.EncodeToString(b)
	val, err := json.Marshal(sessionData{UID: uid, Role: role})
	if err != nil {
		return "", err
	}
	if err := s.redis.Set(ctx, sessionPrefix+id, val, s.cfg.SessionTTL).Err(); err != nil {
		return "", err
	}
	return id, nil
}

// lookupSession resolves a session id to its {uid,role}. A missing key (expired,
// revoked, or forged), an unparseable value, OR a Redis error all return
// ok=false — fail closed, so the caller 401s. Unlike rate limiting, auth must
// NOT fail open: a down cache means "cannot prove this session", i.e. reject.
func (s *Server) lookupSession(ctx context.Context, id string) (sessionData, bool) {
	if id == "" {
		return sessionData{}, false
	}
	raw, err := s.redis.Get(ctx, sessionPrefix+id).Result()
	if err != nil {
		return sessionData{}, false
	}
	var d sessionData
	if err := json.Unmarshal([]byte(raw), &d); err != nil || d.UID == "" {
		return sessionData{}, false
	}
	return d, true
}

// deleteSession revokes a durable session server-side — this is what makes logout
// real. Idempotent: DEL of an absent key is a no-op.
func (s *Server) deleteSession(ctx context.Context, id string) {
	if id != "" {
		s.redis.Del(ctx, sessionPrefix+id)
	}
}

// setSessionCookie writes the durable credential: httpOnly (JS can't read it, so
// XSS can't exfiltrate it), Secure, SameSite=Lax (survives the top-level redirect
// back from Google, but a cross-site page can't ride it), Path=/, living
// SessionTTL. This cookie is the ONLY thing that persists across a page refresh;
// the access JWT stays in memory.
func (s *Server) setSessionCookie(c *fiber.Ctx, id string) {
	c.Cookie(&fiber.Cookie{
		Name:     s.cfg.SessionCookieName,
		Value:    id,
		Path:     "/",
		HTTPOnly: true,
		Secure:   true,
		SameSite: "Lax",
		MaxAge:   int(s.cfg.SessionTTL / time.Second),
	})
}
