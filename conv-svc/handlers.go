package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5/pgconn"
)

var validRoles = map[string]bool{"user": true, "assistant": true, "tool": true}

// GET /healthz
func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := reqCtx(r)
	defer cancel()
	if s.ping != nil {
		if err := s.ping(ctx); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{
				"status": "error", "deps": map[string]string{"postgres": "down"},
			})
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status": "ok", "deps": map[string]string{"postgres": "ok"},
	})
}

// POST /conversations  {user_id, title?}
func (s *Server) handleCreateConversation(w http.ResponseWriter, r *http.Request) {
	var in struct {
		UserID string `json:"user_id"`
		Title  string `json:"title"`
	}
	if err := decodeBody(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if in.UserID == "" {
		writeErr(w, http.StatusBadRequest, "user_id is required")
		return
	}

	ctx, cancel := reqCtx(r)
	defer cancel()

	var c Conversation
	// COALESCE lets an omitted/empty title fall back to the column default.
	err := s.db.QueryRow(ctx,
		`INSERT INTO conversations (user_id, title)
		 VALUES ($1, COALESCE(NULLIF($2, ''), 'New conversation'))
		 RETURNING id, user_id, title, created_at`,
		in.UserID, in.Title,
	).Scan(&c.ID, &c.UserID, &c.Title, &c.CreatedAt)
	if err != nil {
		// FK violation => the user_id does not exist.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) {
			switch pgErr.Code {
			case "23503":
				writeErr(w, http.StatusBadRequest, "user_id does not exist")
				return
			case "22P02":
				writeErr(w, http.StatusBadRequest, "user_id is not a valid uuid")
				return
			}
		}
		writeErr(w, http.StatusInternalServerError, "could not create conversation")
		return
	}
	writeJSON(w, http.StatusCreated, c)
}

// GET /conversations?user_id=
func (s *Server) handleListConversations(w http.ResponseWriter, r *http.Request) {
	userID := r.URL.Query().Get("user_id")
	if userID == "" {
		writeErr(w, http.StatusBadRequest, "user_id query parameter is required")
		return
	}

	ctx, cancel := reqCtx(r)
	defer cancel()

	rows, err := s.db.Query(ctx,
		`SELECT id, user_id, title, created_at
		 FROM conversations
		 WHERE user_id = $1
		 ORDER BY created_at DESC`,
		userID,
	)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "22P02" {
			writeErr(w, http.StatusBadRequest, "user_id is not a valid uuid")
			return
		}
		writeErr(w, http.StatusInternalServerError, "could not list conversations")
		return
	}
	defer rows.Close()

	out := []Conversation{}
	for rows.Next() {
		var c Conversation
		if err := rows.Scan(&c.ID, &c.UserID, &c.Title, &c.CreatedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not read conversations")
			return
		}
		out = append(out, c)
	}
	if rows.Err() != nil {
		writeErr(w, http.StatusInternalServerError, "could not read conversations")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// GET /conversations/{id}/messages
func (s *Server) handleListMessages(w http.ResponseWriter, r *http.Request) {
	convID := r.PathValue("id")

	ctx, cancel := reqCtx(r)
	defer cancel()

	exists, err := s.conversationExists(ctx, convID)
	if err != nil {
		if isInvalidUUID(err) {
			writeErr(w, http.StatusBadRequest, "conversation id is not a valid uuid")
			return
		}
		writeErr(w, http.StatusInternalServerError, "could not load conversation")
		return
	}
	if !exists {
		writeErr(w, http.StatusNotFound, "conversation not found")
		return
	}

	rows, err := s.db.Query(ctx,
		`SELECT id, conversation_id, role, content, tool_calls, created_at
		 FROM messages
		 WHERE conversation_id = $1
		 ORDER BY created_at ASC`,
		convID,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not list messages")
		return
	}
	defer rows.Close()

	out := []Message{}
	for rows.Next() {
		var m Message
		var tc []byte
		if err := rows.Scan(&m.ID, &m.ConversationID, &m.Role, &m.Content, &tc, &m.CreatedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not read messages")
			return
		}
		if tc != nil {
			m.ToolCalls = json.RawMessage(tc)
		}
		out = append(out, m)
	}
	if rows.Err() != nil {
		writeErr(w, http.StatusInternalServerError, "could not read messages")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// POST /conversations/{id}/messages  {role, content, tool_calls?}
func (s *Server) handleCreateMessage(w http.ResponseWriter, r *http.Request) {
	convID := r.PathValue("id")

	var in struct {
		Role      string          `json:"role"`
		Content   string          `json:"content"`
		ToolCalls json.RawMessage `json:"tool_calls"`
	}
	if err := decodeBody(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if !validRoles[in.Role] {
		writeErr(w, http.StatusBadRequest, "role must be one of user|assistant|tool")
		return
	}

	// tool_calls, if present, MUST be our neutral shape. Reject provider wire
	// formats (tool-call ids, type tags, thinking blocks) before the DB sees them.
	var toolCallsArg any // nil => SQL NULL
	if len(in.ToolCalls) > 0 && !isJSONNull(in.ToolCalls) {
		if err := validateToolCalls(in.ToolCalls); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		toolCallsArg = string(in.ToolCalls)
	}

	ctx, cancel := reqCtx(r)
	defer cancel()

	var m Message
	var tc []byte
	err := s.db.QueryRow(ctx,
		`INSERT INTO messages (conversation_id, role, content, tool_calls)
		 VALUES ($1, $2, $3, $4)
		 RETURNING id, conversation_id, role, content, tool_calls, created_at`,
		convID, in.Role, in.Content, toolCallsArg,
	).Scan(&m.ID, &m.ConversationID, &m.Role, &m.Content, &tc, &m.CreatedAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) {
			switch pgErr.Code {
			case "23503": // FK violation: conversation does not exist
				writeErr(w, http.StatusNotFound, "conversation not found")
				return
			case "22P02": // invalid uuid text
				writeErr(w, http.StatusBadRequest, "conversation id is not a valid uuid")
				return
			}
		}
		writeErr(w, http.StatusInternalServerError, "could not create message")
		return
	}
	if tc != nil {
		m.ToolCalls = json.RawMessage(tc)
	}
	writeJSON(w, http.StatusCreated, m)
}

// ---- internals ------------------------------------------------------------

func (s *Server) conversationExists(ctx context.Context, id string) (bool, error) {
	var exists bool
	err := s.db.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM conversations WHERE id = $1)`, id,
	).Scan(&exists)
	if err != nil {
		return false, err
	}
	return exists, nil
}

func decodeBody(r *http.Request, v any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("invalid JSON body: %v", err)
	}
	return nil
}

func isInvalidUUID(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "22P02"
}

func isJSONNull(b []byte) bool {
	for _, c := range b {
		switch c {
		case ' ', '\t', '\n', '\r':
			continue
		case 'n':
			return string(trimSpace(b)) == "null"
		default:
			return false
		}
	}
	return true // all whitespace
}

func trimSpace(b []byte) []byte {
	start, end := 0, len(b)
	for start < end && isSpace(b[start]) {
		start++
	}
	for end > start && isSpace(b[end-1]) {
		end--
	}
	return b[start:end]
}

func isSpace(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' }
