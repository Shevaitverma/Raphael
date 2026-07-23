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

// activePrefix namespaces the last-active throttle keys. The presence of
// active:<uid> means "this uid was stamped within the last activeThrottle" —
// while the key lives, we skip the DB write.
const activePrefix = "active:"

// activeThrottle is the write ceiling: at most one last_active UPDATE per uid
// per this window, no matter how often /auth/session is hit (every page refresh
// hits it). ponytail: fixed 5-min ceiling; if per-user activity granularity ever
// matters, shorten it or stamp elsewhere — do NOT drop the throttle (that turns
// every refresh into a write).
const activeThrottle = 5 * time.Minute

// stampActive records that uid is currently active, throttled so it is at most
// one write per uid per activeThrottle. It SET NX EX on active:<uid>: only when
// the key was NEWLY created (SetNX true) does it run the uid-scoped UPDATE. A
// Redis error, or an already-present key, means "recently stamped or can't tell"
// -> skip silently. This is fire-and-forget from handleSession: a stamp failure
// must NEVER fail the session refresh, so all errors here are swallowed.
//
// Isolation: the UPDATE is scoped to WHERE id=$1 (the caller's own uid from the
// verified session) — single-user by construction, never a cross-user write.
func (s *Server) stampActive(ctx context.Context, uid string) {
	if uid == "" {
		return
	}
	fresh, err := s.redis.SetNX(ctx, activePrefix+uid, "1", activeThrottle).Result()
	if err != nil || !fresh {
		return // Redis down, or stamped within the throttle window -> skip
	}
	// Best-effort: an UPDATE failure just means we miss this stamp; the next
	// touch after the throttle key expires will retry. Never surfaced.
	_, _ = s.db.Exec(ctx, `UPDATE users SET last_active=now() WHERE id=$1`, uid)
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
