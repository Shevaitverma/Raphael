package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
)

// Admin proxies. Every handler here is mounted UNDER requireAdmin (which
// re-reads users.role from the DB, so a stale/crafted JWT can't reach these),
// so the handlers themselves carry no role logic — they are thin, uid-forcing
// forwards, exactly like proxy.go's per-user proxies. Two shapes:
//
//   - System provider/model config → user-svc's PUBLIC credential handlers,
//     rooted at SYSTEM_CONFIG_UID instead of the JWT uid. This is the WHOLE of
//     "admin edits the one system config": no new user-svc CRUD, the existing
//     credential API pointed at the system-owner row. Uses s.forward (public
//     route, no secret) — a verbatim clone of proxyProviders' target-rooting.
//   - Allowlist + user management → user-svc's INTERNAL /internal/admin/*
//     routes, which are requireInternal-gated, so these carry X-Internal-Token
//     via forwardInternal. All REST, zero LLM tokens.

// forwardInternal is s.forward plus the shared-secret header, for the
// requireInternal-gated user-svc /internal/admin/* routes. proxy.go's s.forward
// is the public-route variant and sets no secret; we can't add a header to it
// without editing it, so this mirrors its buffered reverse-proxy exactly and
// adds the one line. FAILS CLOSED upstream: if InternalToken is empty, user-svc
// rejects the call (its requireInternal treats an empty want as reject-all).
// ponytail: ~20 lines duplicated from s.forward; collapse if s.forward ever
// grows an optional-headers param.
func (s *Server) forwardInternal(c *fiber.Ctx, method, targetURL string, body []byte) error {
	ctx, cancel := context.WithTimeout(c.Context(), 15*time.Second)
	defer cancel()

	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, targetURL, rdr)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "bad upstream request")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Internal-Token", s.cfg.InternalToken)

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return fiber.NewError(fiber.StatusBadGateway, "upstream unavailable")
	}
	defer resp.Body.Close()

	if ct := resp.Header.Get("Content-Type"); ct != "" {
		c.Set("Content-Type", ct)
	}
	c.Status(resp.StatusCode)
	_, err = io.Copy(c, resp.Body)
	return err
}

// --- system provider/model config → user-svc (PUBLIC credential routes) -----
//
// The admin edits the ONE system config through the existing per-user credential
// handlers, rooted at SYSTEM_CONFIG_UID instead of a JWT uid. Verbatim reuse of
// proxyProviders' machinery and guards — only the uid the target is rooted at
// moves from the caller to the system singleton.
//
// GET    /api/admin/providers                → GET    /users/<SYS>/credentials
// POST   /api/admin/providers                → POST   /users/<SYS>/credentials
// POST   /api/admin/providers/:id/activate   → POST   /users/<SYS>/credentials/:id/activate
// POST   /api/admin/providers/:id/lifeboat   → POST   /users/<SYS>/credentials/:id/lifeboat
// DELETE /api/admin/providers/:id/lifeboat   → DELETE /users/<SYS>/credentials/:id/lifeboat
func (s *Server) proxySystemProviders(c *fiber.Ctx) error {
	rest := strings.TrimPrefix(c.Path(), "/api/admin/providers")
	// Same defense-in-depth as proxyProviders: the fixed /users/<SYS>/credentials
	// prefix already makes /internal/* unreachable, but we refuse a suspicious
	// path outright.
	if strings.Contains(rest, "..") || strings.Contains(strings.ToLower(rest), "internal") {
		return fiber.NewError(fiber.StatusBadRequest, "invalid path")
	}
	target := s.cfg.UserSvcURL + "/users/" + s.cfg.SystemConfigUID + "/credentials" + rest

	var body []byte
	if len(c.Body()) > 0 {
		body = c.Body()
	}
	return s.forward(c, c.Method(), target, body)
}

// --- allowlist (invites) → user-svc /internal/admin/allowlist ---------------
//
// Adding an email is what permits that person to sign in (no email is sent).
//
// GET    /api/admin/allowlist        → GET    /internal/admin/allowlist
// POST   /api/admin/allowlist {email}→ POST   /internal/admin/allowlist
// DELETE /api/admin/allowlist/:email → DELETE /internal/admin/allowlist/<email>
func (s *Server) proxyAllowlist(c *fiber.Ctx) error {
	target := s.cfg.UserSvcURL + "/internal/admin/allowlist"
	if raw := c.Params("email"); raw != "" {
		// Fiber does NOT url-decode path params, so decode first (an email carries
		// %40 for '@', %2B for '+'), guard the DECODED value (so an encoded %2e%2e
		// traversal is caught too), then re-escape as one clean path segment.
		email, err := url.PathUnescape(raw)
		if err != nil || strings.Contains(email, "..") || strings.Contains(strings.ToLower(email), "internal") {
			return fiber.NewError(fiber.StatusBadRequest, "invalid path")
		}
		target += "/" + url.PathEscape(email)
	}

	var body []byte
	if len(c.Body()) > 0 {
		body = c.Body()
	}
	return s.forwardInternal(c, c.Method(), target, body)
}

// --- user management → user-svc /internal/admin/users -----------------------
//
// GET    /api/admin/users          → GET    /internal/admin/users
// PATCH  /api/admin/users/:id/role → PATCH  /internal/admin/users/<id>/role
// DELETE /api/admin/users/:id      → DELETE /internal/admin/users/<id>
func (s *Server) proxyAdminUsers(c *fiber.Ctx) error {
	target := s.cfg.UserSvcURL + "/internal/admin/users"
	if raw := c.Params("id"); raw != "" {
		id, err := url.PathUnescape(raw)
		if err != nil || strings.Contains(id, "..") || strings.Contains(strings.ToLower(id), "internal") {
			return fiber.NewError(fiber.StatusBadRequest, "invalid path")
		}
		target += "/" + url.PathEscape(id)
		// The role-change route has the /role suffix; DELETE has none. The two are
		// mounted as distinct routes, so the suffix distinguishes them safely.
		if strings.HasSuffix(c.Path(), "/role") {
			target += "/role"
		}
	}

	var body []byte
	if len(c.Body()) > 0 {
		body = c.Body()
	}
	return s.forwardInternal(c, c.Method(), target, body)
}
