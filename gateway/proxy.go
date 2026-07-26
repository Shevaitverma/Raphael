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
	setReqID(c, req) // one id across gateway → user-svc/conv-svc/agent-svc

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

// --- profile proxy → user-svc (PUBLIC routes only) -------------------------
//
// The target path is ALWAYS rooted at /users/<uid>/profile, so the <uid> comes
// from the JWT sub and a client-supplied uid in the path/body is never trusted.
// Same machinery and guards as proxyProviders.
//
// GET /api/profile → GET /users/<uid>/profile
// PUT /api/profile → PUT /users/<uid>/profile
func (s *Server) proxyProfile(c *fiber.Ctx) error {
	uid := c.Locals(userIDKey).(string)

	rest := strings.TrimPrefix(c.Path(), "/api/profile")
	if strings.Contains(rest, "..") || strings.Contains(strings.ToLower(rest), "internal") {
		return fiber.NewError(fiber.StatusBadRequest, "invalid path")
	}
	target := s.cfg.UserSvcURL + "/users/" + uid + "/profile" + rest

	var body []byte
	if len(c.Body()) > 0 {
		body = c.Body()
	}
	return s.forward(c, c.Method(), target, body)
}

// --- tasks proxy → user-svc (PUBLIC routes only) ---------------------------
//
// The target path is ALWAYS rooted at /users/<uid>/tasks, so the <uid> comes
// from the JWT sub and a client-supplied uid is never trusted. The optional
// :id (a task uuid) is appended for PATCH/DELETE. Same machinery and guards as
// proxyProfile.
//
// GET    /api/tasks     → GET    /users/<uid>/tasks
// POST   /api/tasks     → POST   /users/<uid>/tasks
// PATCH  /api/tasks/:id → PATCH  /users/<uid>/tasks/<id>
// DELETE /api/tasks/:id → DELETE /users/<uid>/tasks/<id>
func (s *Server) proxyTasks(c *fiber.Ctx) error {
	uid := c.Locals(userIDKey).(string)

	target := s.cfg.UserSvcURL + "/users/" + uid + "/tasks"
	if id := c.Params("id"); id != "" {
		// Guard the client-supplied id exactly like the path guards above, then
		// path-escape it so it stays a single path segment (no traversal).
		if strings.Contains(id, "..") || strings.Contains(strings.ToLower(id), "internal") {
			return fiber.NewError(fiber.StatusBadRequest, "invalid path")
		}
		target += "/" + url.PathEscape(id)
	}

	var body []byte
	if len(c.Body()) > 0 {
		body = c.Body()
	}
	return s.forward(c, c.Method(), target, body)
}

// --- reminders proxy → user-svc (PUBLIC routes only) -----------------------
//
// The target path is ALWAYS rooted at /users/<uid>/reminders, so the <uid>
// comes from the JWT sub and a client-supplied uid is never trusted. The
// optional :id (a reminder uuid) is appended for PATCH/DELETE. Identical
// machinery and guards as proxyTasks — the tz + schedule are force-stamped
// server-side in user-svc; the gateway only forces the uid.
//
// GET    /api/reminders     → GET    /users/<uid>/reminders
// POST   /api/reminders     → POST   /users/<uid>/reminders
// PATCH  /api/reminders/:id → PATCH  /users/<uid>/reminders/<id>
// DELETE /api/reminders/:id → DELETE /users/<uid>/reminders/<id>
func (s *Server) proxyReminders(c *fiber.Ctx) error {
	uid := c.Locals(userIDKey).(string)

	target := s.cfg.UserSvcURL + "/users/" + uid + "/reminders"
	if id := c.Params("id"); id != "" {
		if strings.Contains(id, "..") || strings.Contains(strings.ToLower(id), "internal") {
			return fiber.NewError(fiber.StatusBadRequest, "invalid path")
		}
		target += "/" + url.PathEscape(id)
	}

	var body []byte
	if len(c.Body()) > 0 {
		body = c.Body()
	}
	return s.forward(c, c.Method(), target, body)
}

// --- notifications proxy → user-svc (PUBLIC routes only) -------------------
//
// The in-app delivery feed (poll-based v1). Rooted at /users/<uid>/notifications
// so the uid always comes from the JWT. The only sub-resource is the fixed /read
// mark-read action, appended after the path-escaped :id. Same guards as above.
//
// GET   /api/notifications          → GET   /users/<uid>/notifications
// PATCH /api/notifications/:id/read → PATCH /users/<uid>/notifications/<id>/read
func (s *Server) proxyNotifications(c *fiber.Ctx) error {
	uid := c.Locals(userIDKey).(string)

	target := s.cfg.UserSvcURL + "/users/" + uid + "/notifications"
	if id := c.Params("id"); id != "" {
		if strings.Contains(id, "..") || strings.Contains(strings.ToLower(id), "internal") {
			return fiber.NewError(fiber.StatusBadRequest, "invalid path")
		}
		target += "/" + url.PathEscape(id) + "/read"
	} else if qs := c.Request().URI().QueryString(); len(qs) > 0 {
		// List read: pass the incoming query (?unread=1) through verbatim. Safe —
		// uid is fixed in the path above, so no client value overrides isolation.
		target += "?" + string(qs)
	}

	var body []byte
	if len(c.Body()) > 0 {
		body = c.Body()
	}
	return s.forward(c, c.Method(), target, body)
}

// --- timezone proxy → user-svc (PUBLIC routes only) ------------------------
//
// The web auto-detects the IANA tz and PUTs it here; a Settings picker also
// writes it. Rooted at /users/<uid>/timezone so the uid comes from the JWT.
// user-svc validates the tz string; the gateway only forces the uid. Clone of
// proxyProfile.
//
// PUT /api/timezone → PUT /users/<uid>/timezone
func (s *Server) proxyTimezone(c *fiber.Ctx) error {
	uid := c.Locals(userIDKey).(string)

	rest := strings.TrimPrefix(c.Path(), "/api/timezone")
	if strings.Contains(rest, "..") || strings.Contains(strings.ToLower(rest), "internal") {
		return fiber.NewError(fiber.StatusBadRequest, "invalid path")
	}
	target := s.cfg.UserSvcURL + "/users/" + uid + "/timezone" + rest

	var body []byte
	if len(c.Body()) > 0 {
		body = c.Body()
	}
	return s.forward(c, c.Method(), target, body)
}

// --- fitness proxy → user-svc (PUBLIC routes only) -------------------------
//
// Workouts + body metrics + stats. Rooted at /users/<uid>/fitness so the uid
// always comes from the JWT, never a client-supplied one. The full subpath
// after /api/fitness (workouts, workouts/<id>, metrics, metrics/<id>, stats) is
// preserved and the query (?type=) passed through. Same TrimPrefix + traversal
// guards as proxyProfile; the :id lands inside `rest` and is covered by the ".."
// guard. One handler covers every fitness verb/path.
//
// GET/POST  /api/fitness/workouts       → …/users/<uid>/fitness/workouts
// DELETE    /api/fitness/workouts/:id   → …/users/<uid>/fitness/workouts/<id>
// GET/POST  /api/fitness/metrics        → …/users/<uid>/fitness/metrics
// DELETE    /api/fitness/metrics/:id    → …/users/<uid>/fitness/metrics/<id>
// GET       /api/fitness/stats          → …/users/<uid>/fitness/stats
// v2 (same passthrough, no per-path code — the full subpath rides `rest`):
// GET       /api/fitness/bmi            → …/users/<uid>/fitness/bmi
// GET/POST  /api/fitness/goals          + PATCH/DELETE /goals/:id
// GET/POST  /api/fitness/nutrition      + PATCH/DELETE /nutrition/:id
// GET       /api/fitness/nutrition/stats
// GET/PUT   /api/fitness/config
func (s *Server) proxyFitness(c *fiber.Ctx) error {
	uid := c.Locals(userIDKey).(string)

	rest := strings.TrimPrefix(c.Path(), "/api/fitness")
	if strings.Contains(rest, "..") || strings.Contains(strings.ToLower(rest), "internal") {
		return fiber.NewError(fiber.StatusBadRequest, "invalid path")
	}
	target := s.cfg.UserSvcURL + "/users/" + uid + "/fitness" + rest

	// List reads carry ?type=; pass it through verbatim. Safe — uid is fixed in
	// the path above, so no client value overrides isolation.
	if qs := c.Request().URI().QueryString(); len(qs) > 0 {
		target += "?" + string(qs)
	}

	var body []byte
	if len(c.Body()) > 0 {
		body = c.Body()
	}
	return s.forward(c, c.Method(), target, body)
}

// --- capabilities proxy → agent-svc ----------------------------------------
//
// GET /api/capabilities → agent-svc GET /capabilities?user_id=<jwt sub>. What
// the active model can do, plus whether this deployment has a search key at
// all — a bool, never the key.
func (s *Server) proxyCapabilities(c *fiber.Ctx) error {
	uid := c.Locals(userIDKey).(string)
	target := s.cfg.AgentSvcURL + "/capabilities?user_id=" + url.QueryEscape(uid)
	return s.forward(c, http.MethodGet, target, nil)
}

// --- memory read proxies → agent-svc ---------------------------------------
//
// GET /api/memory/graph → agent-svc GET /memory/graph?user_id=<jwt sub>
// GET /api/memory/stats → agent-svc GET /memory/stats?user_id=<jwt sub>
// uid comes ONLY from the JWT; a client-supplied user_id in the query is never
// forwarded — the target query is built fresh from the JWT sub. Read-only, so
// no body. Clones of proxyCapabilities.
func (s *Server) proxyMemoryGraph(c *fiber.Ctx) error {
	uid := c.Locals(userIDKey).(string)
	target := s.cfg.AgentSvcURL + "/memory/graph?user_id=" + url.QueryEscape(uid)
	return s.forward(c, http.MethodGet, target, nil)
}

func (s *Server) proxyMemoryStats(c *fiber.Ctx) error {
	uid := c.Locals(userIDKey).(string)
	target := s.cfg.AgentSvcURL + "/memory/stats?user_id=" + url.QueryEscape(uid)
	return s.forward(c, http.MethodGet, target, nil)
}

// GET /api/memory/portrait → agent-svc GET /memory/portrait?user_id=<jwt sub>
// The user-portrait transparency door: what the assistant has inferred about
// the user, read-only. uid from the JWT only. Clone of proxyMemoryStats.
func (s *Server) proxyMemoryPortrait(c *fiber.Ctx) error {
	uid := c.Locals(userIDKey).(string)
	target := s.cfg.AgentSvcURL + "/memory/portrait?user_id=" + url.QueryEscape(uid)
	return s.forward(c, http.MethodGet, target, nil)
}

// --- memory delete proxies → agent-svc -------------------------------------
//
// DELETE /api/memory/facts/:id → agent-svc DELETE /memory/facts/<id>?user_id=<jwt sub>
// DELETE /api/memory/notes/:id → agent-svc DELETE /memory/notes/<id>?user_id=<jwt sub>
//
// Same uid rule as the reads — the query is rebuilt from the JWT sub, so the id
// is the ONLY thing the client controls, and agent-svc deletes on (id, user_id):
// another user's id matches nothing and comes back 404. The :id guard and
// PathEscape are proxyTasks'. Method is hardcoded rather than c.Method() so a
// second verb mounted on this handler later cannot silently widen it.
func (s *Server) proxyDeleteFact(c *fiber.Ctx) error {
	return s.proxyMemoryDelete(c, "/memory/facts/")
}

func (s *Server) proxyDeleteNote(c *fiber.Ctx) error {
	return s.proxyMemoryDelete(c, "/memory/notes/")
}

func (s *Server) proxyMemoryDelete(c *fiber.Ctx, prefix string) error {
	uid := c.Locals(userIDKey).(string)

	id := c.Params("id")
	if strings.Contains(id, "..") || strings.Contains(strings.ToLower(id), "internal") {
		return fiber.NewError(fiber.StatusBadRequest, "invalid path")
	}
	target := s.cfg.AgentSvcURL + prefix + url.PathEscape(id) + "?user_id=" + url.QueryEscape(uid)
	return s.forward(c, http.MethodDelete, target, nil)
}

// --- chat proxy → agent-svc (SSE passthrough) ------------------------------
//
// POST /api/chat {conversation_id, message, search} → agent-svc POST /chat
// {user_id, conversation_id, message}. The text/event-stream response is
// streamed straight through, flushing every chunk so tokens arrive
// incrementally rather than all at once at the end.
func (s *Server) handleChat(c *fiber.Ctx) error {
	uid := c.Locals(userIDKey).(string)

	var in struct {
		ConversationID string `json:"conversation_id"`
		Message        string `json:"message"`
		Search         bool   `json:"search"`
	}
	if err := c.BodyParser(&in); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid body")
	}
	// uid comes from the JWT; the other fields from the client body. The internal
	// (WhatsApp) ingress calls the same helper with a body-supplied uid instead.
	return s.streamChatTo(c, uid, in.ConversationID, in.Message, in.Search)
}

// streamChatTo runs a full chat turn against agent-svc and relays the SSE stream
// back to the client. It is the shared machinery behind both the JWT-gated
// /api/chat and the secret-gated /internal/chat: only the source of uid and the
// other fields differs, so the delicate stream-writer lifecycle lives here once.
func (s *Server) streamChatTo(c *fiber.Ctx, uid, conversationID, message string, search bool) error {
	// Assistant name goes into the system prompt server-side, so it is read from
	// the DB keyed by the uid — NEVER from the client body. Best-effort: any
	// failure (query error, no row, timeout) falls back to "Raphael" and never
	// blocks or delays the chat turn. Single indexed PK lookup. Both callers get
	// it, so a WhatsApp turn also uses the user's chosen assistant name.
	assistantName := "Raphael"
	nctx, ncancel := context.WithTimeout(c.Context(), 2*time.Second)
	if err := s.db.QueryRow(nctx, `SELECT assistant_name FROM users WHERE id=$1`, uid).Scan(&assistantName); err != nil {
		assistantName = "Raphael"
	}
	ncancel()

	// The body is rebuilt field by field, not copied: anything not named here is
	// dropped before it reaches agent-svc.
	payload, _ := json.Marshal(map[string]any{
		"user_id":         uid, // from the JWT (or the internal caller), never the client chat body
		"conversation_id": conversationID,
		"message":         message,
		"search":          search,
		"assistant_name":  assistantName, // from the DB (uid-keyed), never the body
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
	setReqID(c, req)

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
