package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const devUserID = "00000000-0000-0000-0000-000000000001"

// newTestServer opens a transaction and hands the handlers a Server bound to it.
// The transaction is rolled back at the end of the test, so nothing persists.
func newTestServer(t *testing.T) (*Server, func()) {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = "postgresql://raphael:raphael@localhost:5433/raphael"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		cancel()
		t.Skipf("no database available: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		cancel()
		t.Skipf("database not reachable: %v", err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		pool.Close()
		cancel()
		t.Fatalf("begin tx: %v", err)
	}
	srv := newServer(tx, func(ctx context.Context) error { return nil })
	cleanup := func() {
		_ = tx.Rollback(context.Background())
		pool.Close()
		cancel()
	}
	return srv, cleanup
}

func do(t *testing.T, srv *Server, method, target string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatalf("encode body: %v", err)
		}
	}
	req := httptest.NewRequest(method, target, &buf)
	rr := httptest.NewRecorder()
	srv.routes().ServeHTTP(rr, req)
	return rr
}

func TestHealthz(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()
	rr := do(t, srv, "GET", "/healthz", nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("healthz = %d, want 200; body=%s", rr.Code, rr.Body)
	}
	var out map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("healthz body not JSON: %v", err)
	}
	if out["status"] != "ok" {
		t.Fatalf("healthz status = %v, want ok", out["status"])
	}
}

func TestHealthzDBDown(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()
	srv.ping = func(context.Context) error { return context.DeadlineExceeded }
	rr := do(t, srv, "GET", "/healthz", nil)
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("healthz(down) = %d, want 503", rr.Code)
	}
}

func TestCreateConversation(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()

	rr := do(t, srv, "POST", "/conversations", map[string]any{
		"user_id": devUserID, "title": "Hello world",
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("create = %d, want 201; body=%s", rr.Code, rr.Body)
	}
	var c Conversation
	if err := json.Unmarshal(rr.Body.Bytes(), &c); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if c.ID == "" || c.UserID != devUserID || c.Title != "Hello world" {
		t.Fatalf("unexpected conversation: %+v", c)
	}
	if c.CreatedAt.IsZero() {
		t.Fatalf("created_at not set")
	}
}

func TestCreateConversationDefaultTitle(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()
	rr := do(t, srv, "POST", "/conversations", map[string]any{"user_id": devUserID})
	if rr.Code != http.StatusCreated {
		t.Fatalf("create = %d, want 201; body=%s", rr.Code, rr.Body)
	}
	var c Conversation
	_ = json.Unmarshal(rr.Body.Bytes(), &c)
	if c.Title != "New conversation" {
		t.Fatalf("default title = %q, want %q", c.Title, "New conversation")
	}
}

func TestCreateConversationMissingUser(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()
	rr := do(t, srv, "POST", "/conversations", map[string]any{"title": "x"})
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("missing user_id = %d, want 400", rr.Code)
	}
}

func TestCreateConversationBadUser(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()
	// syntactically valid uuid, but not present => FK violation => 400
	rr := do(t, srv, "POST", "/conversations", map[string]any{
		"user_id": "11111111-1111-1111-1111-111111111111",
	})
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("nonexistent user = %d, want 400; body=%s", rr.Code, rr.Body)
	}
}

func TestListConversations(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()

	_ = do(t, srv, "POST", "/conversations", map[string]any{"user_id": devUserID, "title": "one"})
	_ = do(t, srv, "POST", "/conversations", map[string]any{"user_id": devUserID, "title": "two"})

	rr := do(t, srv, "GET", "/conversations?user_id="+devUserID, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("list = %d, want 200; body=%s", rr.Code, rr.Body)
	}
	var list []Conversation
	if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(list) < 2 {
		t.Fatalf("expected >=2 conversations, got %d", len(list))
	}
	// newest first
	if list[0].CreatedAt.Before(list[len(list)-1].CreatedAt) {
		t.Fatalf("conversations not ordered created_at DESC")
	}
}

func TestListConversationsMissingUser(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()
	rr := do(t, srv, "GET", "/conversations", nil)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("missing user_id = %d, want 400", rr.Code)
	}
}

func TestCreateAndListMessages(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()

	convID := createConv(t, srv)

	// a plain user message
	rr := do(t, srv, "POST", "/conversations/"+convID+"/messages", map[string]any{
		"role": "user", "content": "hi there",
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("create msg = %d, want 201; body=%s", rr.Code, rr.Body)
	}

	// an assistant message with neutral tool_calls
	rr = do(t, srv, "POST", "/conversations/"+convID+"/messages", map[string]any{
		"role":    "assistant",
		"content": "",
		"tool_calls": []map[string]any{
			{"name": "search", "arguments": map[string]any{"q": "weather"}},
		},
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("create tool msg = %d, want 201; body=%s", rr.Code, rr.Body)
	}
	var m Message
	if err := json.Unmarshal(rr.Body.Bytes(), &m); err != nil {
		t.Fatalf("decode msg: %v", err)
	}
	if len(m.ToolCalls) == 0 {
		t.Fatalf("tool_calls not round-tripped")
	}

	// list them back, oldest first
	rr = do(t, srv, "GET", "/conversations/"+convID+"/messages", nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("list msgs = %d, want 200; body=%s", rr.Code, rr.Body)
	}
	var msgs []Message
	if err := json.Unmarshal(rr.Body.Bytes(), &msgs); err != nil {
		t.Fatalf("decode msgs: %v", err)
	}
	if len(msgs) != 2 {
		t.Fatalf("got %d messages, want 2", len(msgs))
	}
	if msgs[0].Role != "user" || msgs[1].Role != "assistant" {
		t.Fatalf("messages out of order: %s then %s", msgs[0].Role, msgs[1].Role)
	}
	if msgs[0].ToolCalls != nil {
		t.Fatalf("user message should have null tool_calls, got %s", msgs[0].ToolCalls)
	}
	// verify the stored tool_calls are exactly our neutral shape
	var arr []map[string]json.RawMessage
	if err := json.Unmarshal(msgs[1].ToolCalls, &arr); err != nil {
		t.Fatalf("stored tool_calls not array: %v", err)
	}
	if _, ok := arr[0]["name"]; !ok {
		t.Fatalf("stored tool_calls missing name")
	}
}

func TestCreateMessageBadRole(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()
	convID := createConv(t, srv)
	rr := do(t, srv, "POST", "/conversations/"+convID+"/messages", map[string]any{
		"role": "system", "content": "nope",
	})
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("bad role = %d, want 400; body=%s", rr.Code, rr.Body)
	}
}

func TestCreateMessageProviderWireFormatRejected(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()
	convID := createConv(t, srv)

	// Anthropic-style tool_use block: has id/type/input, not name/arguments.
	cases := []any{
		[]map[string]any{{"id": "toolu_123", "name": "search", "input": map[string]any{"q": "x"}}},
		[]map[string]any{{"type": "function", "name": "search", "arguments": map[string]any{}}},
		[]map[string]any{{"name": "search"}},                                    // missing arguments
		[]map[string]any{{"arguments": map[string]any{}}},                       // missing name
		[]map[string]any{{"name": "", "arguments": map[string]any{}}},           // empty name
		map[string]any{"name": "search", "arguments": map[string]any{}},         // object, not array
	}
	for i, tc := range cases {
		rr := do(t, srv, "POST", "/conversations/"+convID+"/messages", map[string]any{
			"role": "assistant", "content": "", "tool_calls": tc,
		})
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("case %d: got %d, want 400; body=%s", i, rr.Code, rr.Body)
		}
	}
}

func TestMessagesForMissingConversation(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()
	missing := "22222222-2222-2222-2222-222222222222"
	rr := do(t, srv, "GET", "/conversations/"+missing+"/messages", nil)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("list missing conv = %d, want 404; body=%s", rr.Code, rr.Body)
	}
	rr = do(t, srv, "POST", "/conversations/"+missing+"/messages", map[string]any{
		"role": "user", "content": "hi",
	})
	if rr.Code != http.StatusNotFound {
		t.Fatalf("post to missing conv = %d, want 404; body=%s", rr.Code, rr.Body)
	}
}

// createConv creates a conversation via the API and returns its id.
func createConv(t *testing.T, srv *Server) string {
	t.Helper()
	rr := do(t, srv, "POST", "/conversations", map[string]any{"user_id": devUserID})
	if rr.Code != http.StatusCreated {
		t.Fatalf("setup create conv = %d; body=%s", rr.Code, rr.Body)
	}
	var c Conversation
	if err := json.Unmarshal(rr.Body.Bytes(), &c); err != nil {
		t.Fatalf("setup decode: %v", err)
	}
	return c.ID
}

// compile-time assertion that pgx.Tx satisfies DB.
var _ DB = (pgx.Tx)(nil)
