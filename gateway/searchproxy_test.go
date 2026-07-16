package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// handleChat rebuilds the upstream body field by field rather than copying it,
// so a new request field reaches agent-svc only if it is named there. This is
// the check that fails if `search` is ever dropped from that map again — the
// toggle would then be a checkbox that silently does nothing.
func TestChatProxyForwardsSearchFlag(t *testing.T) {
	for _, want := range []bool{true, false} {
		t.Run(fmt.Sprintf("search=%v", want), func(t *testing.T) {
			got := make(chan map[string]any, 1)
			agent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				var m map[string]any
				_ = json.Unmarshal(body, &m)
				got <- m
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, "event: done\ndata: {}\n\n")
			}))
			defer agent.Close()

			srv := newServerT(t, testConfig("http://127.0.0.1:1", "http://127.0.0.1:1", agent.URL))
			app := srv.BuildApp()
			token, uid := login(t, app, fmt.Sprintf("search-%d@raphael.local", time.Now().UnixNano()))

			body, _ := json.Marshal(map[string]any{
				"conversation_id": "c1",
				"message":         "who won the most recent F1 race",
				"search":          want,
				"user_id":         "00000000-0000-0000-0000-000000000009", // must be ignored
			})
			req := httptest.NewRequest(http.MethodPost, "/api/chat", bytes.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+token)
			if _, err := app.Test(req, 5000); err != nil {
				t.Fatal(err)
			}

			select {
			case m := <-got:
				if m["search"] != want {
					t.Fatalf("agent-svc saw search=%v (%T), want %v", m["search"], m["search"], want)
				}
				// The spoofed user_id in the body must never win over the JWT.
				if m["user_id"] != uid {
					t.Fatalf("user_id = %v, want the JWT subject %v", m["user_id"], uid)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("agent-svc never received the chat request")
			}
		})
	}
}
