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

type User struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
}

// mintToken produces an HS256 JWT with sub = user uuid and a 24h expiry.
func (s *Server) mintToken(userID string) (string, error) {
	claims := jwt.MapClaims{
		"sub": userID,
		"exp": time.Now().Add(24 * time.Hour).Unix(),
		"iat": time.Now().Unix(),
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return tok.SignedString([]byte(s.cfg.JWTSecret))
}

// parseToken validates an HS256 JWT and returns the sub (user uuid).
func (s *Server) parseToken(raw string) (string, error) {
	tok, err := jwt.Parse(raw, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, jwt.ErrTokenSignatureInvalid
		}
		return []byte(s.cfg.JWTSecret), nil
	})
	if err != nil {
		return "", err
	}
	claims, ok := tok.Claims.(jwt.MapClaims)
	if !ok || !tok.Valid {
		return "", jwt.ErrTokenInvalidClaims
	}
	sub, _ := claims["sub"].(string)
	if sub == "" {
		return "", jwt.ErrTokenInvalidClaims
	}
	return sub, nil
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
	// address. The name defaults to the local-part of the email on insert.
	err := s.db.QueryRow(ctx, `
		INSERT INTO users (email, name)
		VALUES ($1, split_part($1, '@', 1))
		ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
		RETURNING id, email, name`, email).Scan(&u.ID, &u.Email, &u.Name)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "could not resolve user")
	}

	token, err := s.mintToken(u.ID)
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
	sub, err := s.parseToken(raw)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, "invalid token")
	}
	c.Locals(userIDKey, sub)
	return c.Next()
}
