package main

import (
	"crypto/subtle"

	"github.com/gofiber/fiber/v2"
)

// requireInternal rejects any /internal/* request lacking the shared secret.
// Constant-time compare so the check can't be timing-probed. FAILS CLOSED: if
// InternalToken is empty the route rejects everything, so an unconfigured
// gateway never exposes an open, unauthenticated chat ingress. Mirrors
// user-svc's requireInternal (crypto/subtle) — the same trust boundary.
func (s *Server) requireInternal(c *fiber.Ctx) error {
	want := []byte(s.cfg.InternalToken)
	got := []byte(c.Get("X-Internal-Token"))
	if len(want) == 0 || subtle.ConstantTimeCompare(got, want) != 1 {
		return fiber.NewError(fiber.StatusUnauthorized, "internal endpoint")
	}
	return c.Next()
}

// handleInternalChat is the trusted internal chat-ingress (Phase 1 of the
// WhatsApp bridge). An inbound WhatsApp message has no JWT, so unlike /api/chat
// the user_id comes from the BODY. The route is NOT under the /api JWT group; it
// is authenticated solely by requireInternal's shared secret, which runs first.
// On a good token it streams the SAME text/event-stream as /api/chat.
func (s *Server) handleInternalChat(c *fiber.Ctx) error {
	var in struct {
		UserID         string `json:"user_id"`
		ConversationID string `json:"conversation_id"`
		Message        string `json:"message"`
		Search         bool   `json:"search"`
	}
	if err := c.BodyParser(&in); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid body")
	}
	if !isUUID(in.UserID) || !isUUID(in.ConversationID) {
		return fiber.NewError(fiber.StatusBadRequest, "user_id and conversation_id must be uuids")
	}
	return s.streamChatTo(c, in.UserID, in.ConversationID, in.Message, in.Search)
}

// isUUID checks the canonical 8-4-4-4-12 hex form. The pipeline keys everything
// off user_id, so a malformed one must be rejected before it reaches agent-svc.
func isUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, r := range s {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if r != '-' {
				return false
			}
			continue
		}
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')) {
			return false
		}
	}
	return true
}
