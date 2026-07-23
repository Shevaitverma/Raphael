package main

import (
	"context"
	"fmt"
	"time"

	"github.com/gofiber/fiber/v2"
)

// rateLimitMiddleware enforces 60 requests/minute/user using a fixed one-minute
// window in Redis (INCR + EXPIRE). It runs after authMiddleware so the user id
// is available. If Redis is unreachable we fail OPEN — the gateway must not go
// dark because the cache blinked — but we still surface that in /healthz.
func (s *Server) rateLimitMiddleware(c *fiber.Ctx) error {
	uid, _ := c.Locals(userIDKey).(string)
	if uid == "" {
		// Should never happen (auth runs first), but be safe.
		return c.Next()
	}

	ctx, cancel := context.WithTimeout(c.Context(), 500*time.Millisecond)
	defer cancel()

	window := time.Now().Unix() / 60
	key := fmt.Sprintf("ratelimit:%s:%d", uid, window)

	count, err := s.redis.Incr(ctx, key).Result()
	if err != nil {
		// Fail open: allow the request, note the degraded cache in /healthz.
		return c.Next()
	}
	if count == 1 {
		// First hit in this window: set the TTL so the counter self-clears.
		s.redis.Expire(ctx, key, 61*time.Second)
	}
	if count > int64(s.cfg.RateLimitPerMin) {
		c.Set("Retry-After", "60")
		return fiber.NewError(fiber.StatusTooManyRequests, fmt.Sprintf("rate limit exceeded: %d req/min", s.cfg.RateLimitPerMin))
	}
	return c.Next()
}
