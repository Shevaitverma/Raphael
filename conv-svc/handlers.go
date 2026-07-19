package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
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
	userID, err := queryUserID(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
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

// GET /conversations/{id}/messages?user_id=&limit=
func (s *Server) handleListMessages(w http.ResponseWriter, r *http.Request) {
	convID := r.PathValue("id")
	userID, err := queryUserID(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	limit, err := queryLimit(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	ctx, cancel := reqCtx(r)
	defer cancel()

	// A conversation owned by someone else is indistinguishable from one that
	// does not exist: both 404. A 403 here would confirm the id is real.
	owned, err := s.conversationOwnedBy(ctx, convID, userID)
	if err != nil {
		if isInvalidUUID(err) {
			writeErr(w, http.StatusBadRequest, "conversation id is not a valid uuid")
			return
		}
		writeErr(w, http.StatusInternalServerError, "could not load conversation")
		return
	}
	if !owned {
		writeErr(w, http.StatusNotFound, "conversation not found")
		return
	}

	// The N most recent messages, still oldest-first: take the tail with a DESC
	// sort, then reverse it. LIMIT NULL is "no limit" in Postgres, so the
	// unlimited case is the same statement with no extra branch.
	//
	// Both sorts tiebreak on id because created_at is not unique: now() is the
	// TRANSACTION timestamp, so any two messages written in one transaction share
	// it exactly. Without a tiebreak the tail and the reversal are free to
	// disagree about which rows they picked. With it they agree — but see
	// TestListMessagesLimitOrdering: id is a random uuid, so the order it settles
	// on among tied rows is stable, NOT insertion order.
	rows, err := s.db.Query(ctx,
		`SELECT id, conversation_id, role, content, tool_calls, answered_model, degraded, created_at FROM (
		   SELECT id, conversation_id, role, content, tool_calls, answered_model, degraded, created_at
		   FROM messages
		   WHERE conversation_id = $1
		   ORDER BY created_at DESC, id DESC
		   LIMIT $2
		 ) tail
		 ORDER BY created_at ASC, id ASC`,
		convID, limit,
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
		if err := rows.Scan(&m.ID, &m.ConversationID, &m.Role, &m.Content, &tc, &m.AnsweredModel, &m.Degraded, &m.CreatedAt); err != nil {
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

// POST /conversations/{id}/messages?user_id=  {role, content, tool_calls?}
func (s *Server) handleCreateMessage(w http.ResponseWriter, r *http.Request) {
	convID := r.PathValue("id")
	userID, err := queryUserID(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	var in struct {
		Role      string          `json:"role"`
		Content   string          `json:"content"`
		ToolCalls json.RawMessage `json:"tool_calls"`
		// Pointers so "absent" is distinguishable from an explicit zero: an absent
		// answered_model stores NULL, an absent degraded stores false. Declared so
		// DisallowUnknownFields accepts them from agent-svc.
		AnsweredModel *string `json:"answered_model"`
		Degraded      *bool   `json:"degraded"`
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

	// Absent answered_model => SQL NULL; absent degraded => false (the column
	// default). Deref only when present so the pointers stay the "absent" signal.
	var answeredModelArg any // nil => SQL NULL
	if in.AnsweredModel != nil {
		answeredModelArg = *in.AnsweredModel
	}
	degradedArg := false
	if in.Degraded != nil {
		degradedArg = *in.Degraded
	}

	ctx, cancel := reqCtx(r)
	defer cancel()

	var m Message
	var tc []byte
	// The EXISTS guard makes the insert conditional on ownership in a single
	// statement: a conversation belonging to another user matches no row, so the
	// insert writes nothing and Scan reports ErrNoRows => 404, exactly as for an
	// id that does not exist. It also subsumes the old FK-violation branch.
	err = s.db.QueryRow(ctx,
		`INSERT INTO messages (conversation_id, role, content, tool_calls, answered_model, degraded)
		 SELECT $1::uuid, $2::text, $3::text, $4::jsonb, $6::text, $7::boolean
		 WHERE EXISTS (SELECT 1 FROM conversations WHERE id = $1 AND user_id = $5)
		 RETURNING id, conversation_id, role, content, tool_calls, answered_model, degraded, created_at`,
		convID, in.Role, in.Content, toolCallsArg, userID, answeredModelArg, degradedArg,
	).Scan(&m.ID, &m.ConversationID, &m.Role, &m.Content, &tc, &m.AnsweredModel, &m.Degraded, &m.CreatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "conversation not found")
			return
		}
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "22P02" { // invalid uuid text
			writeErr(w, http.StatusBadRequest, "conversation id is not a valid uuid")
			return
		}
		writeErr(w, http.StatusInternalServerError, "could not create message")
		return
	}
	if tc != nil {
		m.ToolCalls = json.RawMessage(tc)
	}

	// Derive the conversation title from its FIRST user message. Best-effort and
	// non-fatal: the message is already written. The guards make it correct and
	// idempotent — count(*)=1 means this insert IS the first message (0 before),
	// title='New conversation' means the user/a prior derivation never named it,
	// and user_id=$3 keeps the same ownership scope the insert just passed so this
	// can never title someone else's conversation.
	if in.Role == "user" {
		if title := deriveTitle(in.Content); title != "" {
			_, _ = s.db.Exec(ctx,
				`UPDATE conversations SET title = $1
				 WHERE id = $2 AND user_id = $3 AND title = 'New conversation'
				   AND (SELECT count(*) FROM messages WHERE conversation_id = $2) = 1`,
				title, convID, userID)
		}
	}

	writeJSON(w, http.StatusCreated, m)
}

// deriveTitle turns a message into a conversation title: trimmed, collapsed to
// one line (Fields splits on any run of unicode whitespace), and truncated to
// ~60 runes with an ellipsis when cut. Empty (all-whitespace) => "" and the
// caller skips the update rather than naming a conversation "".
func deriveTitle(content string) string {
	t := strings.Join(strings.Fields(content), " ")
	r := []rune(t)
	if len(r) > 60 {
		return string(r[:60]) + "…"
	}
	return t
}

// ---- internals ------------------------------------------------------------

// conversationOwnedBy answers the only question the message handlers may ask
// about a conversation: does it belong to this user? Existence alone is not an
// authorization answer — checking it was the bug.
func (s *Server) conversationOwnedBy(ctx context.Context, id, userID string) (bool, error) {
	var owned bool
	err := s.db.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2)`, id, userID,
	).Scan(&owned)
	if err != nil {
		return false, err
	}
	return owned, nil
}

// queryUserID returns the one user_id query parameter. A repeated user_id is
// rejected rather than resolved: url.Values.Get returns the FIRST value, so a
// caller that appends its trusted user_id after a client-supplied query string
// would be silently overruled by an attacker's ?user_id=<victim>. conv-svc owns
// this data and does not trust its caller to have built the query correctly.
func queryUserID(r *http.Request) (string, error) {
	v := r.URL.Query()["user_id"]
	if len(v) == 0 || v[0] == "" {
		return "", errors.New("user_id query parameter is required")
	}
	if len(v) > 1 {
		return "", errors.New("user_id query parameter must appear exactly once")
	}
	return v[0], nil
}

// maxMessageLimit caps ?limit=. agent-svc wants the last handful of turns; a
// client asking for more than this gets the cap, not the world.
const maxMessageLimit = 500

// queryLimit reads ?limit=N. Absent (or ?limit=) means nil => SQL LIMIT NULL =>
// no limit: the whole conversation, exactly as before this parameter existed.
// Present but not a positive integer is a client bug, not a default — silently
// serving 500 messages to a caller who asked for "ten" is how a context window
// blows up in production.
func queryLimit(r *http.Request) (any, error) {
	v := r.URL.Query().Get("limit")
	if v == "" {
		return nil, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 {
		return nil, errors.New("limit must be a positive integer")
	}
	return min(n, maxMessageLimit), nil
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
