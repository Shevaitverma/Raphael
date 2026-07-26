package main

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// DB is the subset of pgx used by the handlers. Both *pgxpool.Pool and pgx.Tx
// satisfy it, so tests can run against a rolled-back transaction.
type DB interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

type Server struct {
	db   DB
	ping func(context.Context) error
}

// pool implements both DB and a Ping; wire it up in main.
func newServer(db DB, ping func(context.Context) error) *Server {
	return &Server{db: db, ping: ping}
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth) // uniform cross-service health
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("POST /conversations", s.handleCreateConversation)
	mux.HandleFunc("GET /conversations", s.handleListConversations)
	mux.HandleFunc("GET /conversations/{id}/messages", s.handleListMessages)
	mux.HandleFunc("POST /conversations/{id}/messages", s.handleCreateMessage)
	mux.HandleFunc("DELETE /conversations/{id}", s.handleDeleteConversation)
	return mux
}

// ---- domain types ---------------------------------------------------------

type Conversation struct {
	ID        string    `json:"id"`
	UserID    string    `json:"user_id"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"created_at"`
}

type Message struct {
	ID             string          `json:"id"`
	ConversationID string          `json:"conversation_id"`
	Role           string          `json:"role"`
	Content        string          `json:"content"`
	ToolCalls      json.RawMessage `json:"tool_calls,omitempty"`
	// Provenance of an assistant turn, persisted so a reload shows what SSE showed:
	// pointer + no omitempty so a user message serializes answered_model as null,
	// not a missing key. degraded is false on every non-degraded/user row.
	AnsweredModel    *string   `json:"answered_model"`
	AnsweredProvider *string   `json:"answered_provider"`
	Degraded         bool      `json:"degraded"`
	CreatedAt        time.Time `json:"created_at"`
}

// ---- helpers --------------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func reqCtx(r *http.Request) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), 10*time.Second)
}
