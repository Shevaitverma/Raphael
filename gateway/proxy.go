package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
)

// forward performs a plain (buffered) reverse-proxy call to targetURL and copies
// the upstream status, selected headers, and body back to the client. Used for
// the conv-svc and user-svc JSON routes. It is deliberately NOT used for SSE.
func (s *Server) forward(c *fiber.Ctx, method, targetURL string, body []byte) error {
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

// injectUserID overwrites the user_id field of a JSON object body with the
// authenticated uuid, so a client can never spoof another user by putting a
// different user_id in the body. A nil/empty/non-object body is returned with a
// freshly built {"user_id": uid} object when forceObject is true.
func injectUserID(body []byte, uid string, forceObject bool) []byte {
	var obj map[string]any
	if len(bytes.TrimSpace(body)) > 0 {
		if err := json.Unmarshal(body, &obj); err != nil || obj == nil {
			obj = nil
		}
	}
	if obj == nil {
		if !forceObject {
			return body
		}
		obj = map[string]any{}
	}
	obj["user_id"] = uid
	out, _ := json.Marshal(obj)
	return out
}

// --- conversations proxy → conv-svc ---------------------------------------
//
// /api/conversations           → /conversations
// /api/conversations/:id/...    → /conversations/:id/...
// user_id always comes from the JWT: it is injected into the body (for writes)
// and appended as a query param (for the list read). The body is never trusted.
func (s *Server) proxyConversations(c *fiber.Ctx) error {
	uid := c.Locals(userIDKey).(string)

	// Strip the leading /api to get the conv-svc path.
	rest := strings.TrimPrefix(c.Path(), "/api/conversations")
	if strings.Contains(rest, "..") {
		return fiber.NewError(fiber.StatusBadRequest, "invalid path")
	}
	target := s.cfg.ConvSvcURL + "/conversations" + rest

	// Preserve any existing query, then force user_id from the JWT. Set, never
	// append: url.Values.Get upstream returns the FIRST value, so appending ours
	// after a client's ?user_id=<victim> would hand the victim's id to conv-svc.
	q, err := url.ParseQuery(string(c.Request().URI().QueryString()))
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid query string")
	}
	q.Set("user_id", uid)
	target += "?" + q.Encode()

	var body []byte
	if len(c.Body()) > 0 {
		// Any write carrying a JSON body has its user_id forced to the JWT sub.
		body = injectUserID(c.Body(), uid, true)
	}
	return s.forward(c, c.Method(), target, body)
}

// --- providers proxy → user-svc (PUBLIC routes only) -----------------------
//
// The target path is ALWAYS rooted at /users/<uid>/credentials, so there is no
// reachable path that lands on user-svc's /internal/* endpoints.
//
// GET  /api/providers              → GET  /users/<uid>/credentials
// POST /api/providers              → POST /users/<uid>/credentials
// POST /api/providers/:id/activate → POST /users/<uid>/credentials/:id/activate
func (s *Server) proxyProviders(c *fiber.Ctx) error {
	uid := c.Locals(userIDKey).(string)

	rest := strings.TrimPrefix(c.Path(), "/api/providers")
	// Defense in depth: reject any traversal attempt outright. Even without
	// this, the fixed /users/<uid>/credentials prefix makes /internal/*
	// unreachable, but we refuse to forward a suspicious path at all.
	if strings.Contains(rest, "..") || strings.Contains(strings.ToLower(rest), "internal") {
		return fiber.NewError(fiber.StatusBadRequest, "invalid path")
	}
	target := s.cfg.UserSvcURL + "/users/" + uid + "/credentials" + rest

	var body []byte
	if len(c.Body()) > 0 {
		body = c.Body()
	}
	return s.forward(c, c.Method(), target, body)
}

// --- chat proxy → agent-svc (SSE passthrough) ------------------------------
//
// POST /api/chat {conversation_id, message} → agent-svc POST /chat
// {user_id, conversation_id, message}. The text/event-stream response is
// streamed straight through, flushing every chunk so tokens arrive
// incrementally rather than all at once at the end.
func (s *Server) handleChat(c *fiber.Ctx) error {
	uid := c.Locals(userIDKey).(string)

	var in struct {
		ConversationID string `json:"conversation_id"`
		Message        string `json:"message"`
	}
	if err := c.BodyParser(&in); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid body")
	}
	payload, _ := json.Marshal(map[string]any{
		"user_id":         uid, // from the JWT, never the body
		"conversation_id": in.ConversationID,
		"message":         in.Message,
	})

	// A cancellable background context: it must outlive the handler return
	// (the stream writer runs afterwards) but be torn down when we finish.
	ctx, cancel := context.WithCancel(context.Background())

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.cfg.AgentSvcURL+"/chat", bytes.NewReader(payload))
	if err != nil {
		cancel()
		return sseError(c, "could not build upstream request")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")

	resp, err := s.streamClient.Do(req)
	if err != nil {
		cancel()
		return sseError(c, "agent service unavailable")
	}

	c.Set("Content-Type", "text/event-stream")
	c.Set("Cache-Control", "no-cache")
	c.Set("Connection", "keep-alive")
	c.Set("X-Accel-Buffering", "no") // defeat nginx/proxy buffering
	c.Status(resp.StatusCode)

	c.Context().SetBodyStreamWriter(func(w *bufio.Writer) {
		defer cancel()
		defer resp.Body.Close()
		buf := make([]byte, 2048)
		for {
			n, rerr := resp.Body.Read(buf)
			if n > 0 {
				if _, werr := w.Write(buf[:n]); werr != nil {
					return
				}
				// Flush every chunk: this is what makes the stream unbuffered.
				if ferr := w.Flush(); ferr != nil {
					return
				}
			}
			if rerr != nil {
				return
			}
		}
	})
	return nil
}

// sseError writes a single SSE error event. Used when the gateway itself cannot
// reach agent-svc, so the browser's EventSource-style reader still gets a
// well-formed error rather than a bare HTTP failure.
func sseError(c *fiber.Ctx, msg string) error {
	c.Set("Content-Type", "text/event-stream")
	c.Set("Cache-Control", "no-cache")
	c.Status(fiber.StatusOK)
	return c.SendString(fmt.Sprintf("event: error\ndata: {\"message\":%q}\n\n", msg))
}
