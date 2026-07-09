package main

import (
	"context"
	"net/http"
	"time"

	"github.com/gofiber/fiber/v2"
)

// handleHealth reports the gateway's own status plus a live probe of each
// dependency. The gateway itself is "ok" as long as it can answer; a downed
// dependency is reported in deps but does not fail the endpoint (it always
// returns 200 so orchestration can read the detail).
func (s *Server) handleHealth(c *fiber.Ctx) error {
	deps := fiber.Map{
		"redis":     s.pingRedis(),
		"user_svc":  s.pingHTTP(s.cfg.UserSvcURL + "/healthz"),
		"conv_svc":  s.pingHTTP(s.cfg.ConvSvcURL + "/healthz"),
		"agent_svc": s.pingHTTP(s.cfg.AgentSvcURL + "/healthz"),
	}
	return c.JSON(fiber.Map{"status": "ok", "deps": deps})
}

func (s *Server) pingRedis() string {
	ctx, cancel := context.WithTimeout(context.Background(), 800*time.Millisecond)
	defer cancel()
	if err := s.redis.Ping(ctx).Err(); err != nil {
		return "down"
	}
	return "ok"
}

func (s *Server) pingHTTP(url string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 800*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "down"
	}
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return "down"
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 500 {
		return "ok"
	}
	return "down"
}
