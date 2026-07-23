package main

import (
	"context"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
)

// userIDKey is the Fiber Locals key under which the authenticated user's uuid
// is stored by the auth middleware. Handlers read it via c.Locals; they never
// trust a user_id coming from the request body.
const userIDKey = "user_id"

// roleKey is the Fiber Locals key holding the role claim ('admin'|'member').
// Convenience for handlers that only need to hint UI; privileged MUTATIONS must
// NOT trust it — requireAdmin re-reads role from Postgres (fail-closed).
const roleKey = "role"

type User struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
	Role  string `json:"role"`
}

// mintToken produces an HS256 JWT with sub = user uuid, a role claim, and a
// SHORT AccessTTL expiry (default 1h). This is the in-memory access token the SPA
// holds; the durable credential is the httpOnly session cookie, which /auth/session
// trades for a fresh access JWT on every call. A short exp bounds a leaked token.
func (s *Server) mintToken(userID, role string) (string, error) {
	claims := jwt.MapClaims{
		"sub":  userID,
		"role": role,
		"exp":  time.Now().Add(s.cfg.AccessTTL).Unix(),
		"iat":  time.Now().Unix(),
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return tok.SignedString([]byte(s.cfg.JWTSecret))
}

// parseToken validates an HS256 JWT and returns the sub (user uuid) and role
// claim. An absent role yields "" — callers needing authority re-check the DB.
func (s *Server) parseToken(raw string) (sub, role string, err error) {
	tok, err := jwt.Parse(raw, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, jwt.ErrTokenSignatureInvalid
		}
		return []byte(s.cfg.JWTSecret), nil
	})
	if err != nil {
		return "", "", err
	}
	claims, ok := tok.Claims.(jwt.MapClaims)
	if !ok || !tok.Valid {
		return "", "", jwt.ErrTokenInvalidClaims
	}
	sub, _ = claims["sub"].(string)
	if sub == "" {
		return "", "", jwt.ErrTokenInvalidClaims
	}
	role, _ = claims["role"].(string)
	return sub, role, nil
}

// handleDevLogin implements POST /auth/dev-login. Only mounted when
// DEV_AUTH_ENABLED=true. Looks the user up in Postgres directly (an upsert so
// any dev email works) and mints a JWT for them.
func (s *Server) handleDevLogin(c *fiber.Ctx) error {
	var body struct {
		Email string `json:"email"`
	}
	if err := c.BodyParser(&body); err != nil || strings.TrimSpace(body.Email) == "" {
		return fiber.NewError(fiber.StatusBadRequest, "email is required")
	}
	email := strings.TrimSpace(body.Email)

	ctx, cancel := context.WithTimeout(c.Context(), 5*time.Second)
	defer cancel()

	var u User
	// Upsert by email so dev-login works for the seeded user and any new dev
	// address. The name defaults to the local-part of the email on insert; role
	// falls to the column default ('member') on insert, and returns the existing
	// role on conflict — so DEV_UID dev-login returns 'admin', throwaways 'member'.
	err := s.db.QueryRow(ctx, `
		INSERT INTO users (email, name)
		VALUES ($1, split_part($1, '@', 1))
		ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
		RETURNING id, email, name, role`, email).Scan(&u.ID, &u.Email, &u.Name, &u.Role)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "could not resolve user")
	}

	// Dev-login now also mints the DURABLE session so a dev's refresh persists
	// exactly like a real Google login (same cookie, same /auth/session re-issue).
	id, err := s.createSession(ctx, u.ID, u.Role)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "could not create session")
	}
	s.setSessionCookie(c, id)

	token, err := s.mintToken(u.ID, u.Role)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "could not mint token")
	}
	return c.JSON(fiber.Map{"token": token, "user": u})
}

// authMiddleware guards /api/*. It requires a Bearer token, validates it, and
// stashes the user uuid in Locals for downstream handlers.
func (s *Server) authMiddleware(c *fiber.Ctx) error {
	h := c.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		return fiber.NewError(fiber.StatusUnauthorized, "missing bearer token")
	}
	raw := strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
	sub, role, err := s.parseToken(raw)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, "invalid token")
	}
	c.Locals(userIDKey, sub)
	c.Locals(roleKey, role)
	return c.Next()
}

// requireAdmin gates admin routes. It runs AFTER authMiddleware and, per the
// fail-closed invariant, RE-READS the role from Postgres — it never trusts the
// JWT's role claim, which could be stale (demoted after issuance) or crafted.
// 403 unless the DB says 'admin'. Reuses s.db, the same handle proxy.go uses.
func (s *Server) requireAdmin(c *fiber.Ctx) error {
	uid, _ := c.Locals(userIDKey).(string)
	if uid == "" {
		return fiber.NewError(fiber.StatusUnauthorized, "missing user")
	}
	ctx, cancel := context.WithTimeout(c.Context(), 5*time.Second)
	defer cancel()

	var role string
	if err := s.db.QueryRow(ctx, `SELECT role FROM users WHERE id=$1`, uid).Scan(&role); err != nil {
		// No row or query error -> fail closed.
		return fiber.NewError(fiber.StatusForbidden, "admin only")
	}
	if role != "admin" {
		return fiber.NewError(fiber.StatusForbidden, "admin only")
	}
	c.Locals(roleKey, role) // reflect the authoritative role downstream
	return c.Next()
}
