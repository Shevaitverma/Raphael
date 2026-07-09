package main

import (
	"context"
	"net/http"
	"time"

	"github.com/gofiber/fiber/v2"
)

// handleHealth is the LIVENESS probe. It answers 200 as long as the process is
// running. It deliberately does NOT probe downstream dependencies: a transient
// blip in Redis or a downstream service must not cause Kubernetes to kill and
// restart an otherwise-healthy gateway.
func (s *Server) handleHealth(c *fiber.Ctx) error {
	return c.JSON(fiber.Map{"status": "ok"})
}

// handleReady is the READINESS probe. It reports whether the gateway should
// receive traffic. Redis is required (rate limiting can't function without it),
// so a downed Redis returns 503 and the pod is pulled from the load balancer.
// Downstream services are reported for visibility but do not fail readiness —
// the gateway degrades per-route (502) rather than going dark for all traffic.
func (s *Server) handleReady(c *fiber.Ctx) error {
	redis := s.pingRedis()
	deps := fiber.Map{
		"redis":     redis,
		"user_svc":  s.pingHTTP(s.cfg.UserSvcURL + "/healthz"),
		"conv_svc":  s.pingHTTP(s.cfg.ConvSvcURL + "/healthz"),
		"agent_svc": s.pingHTTP(s.cfg.AgentSvcURL + "/healthz"),
	}
	if redis != "ok" {
		return c.Status(http.StatusServiceUnavailable).
			JSON(fiber.Map{"status": "not_ready", "deps": deps})
	}
	return c.JSON(fiber.Map{"status": "ready", "deps": deps})
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
