package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// testConfig returns a Config wired to real (running) Postgres + Redis and to
// the fake upstream URLs the caller provides.
func testConfig(userSvc, convSvc, agentSvc string) Config {
	c := LoadConfig() // picks up DATABASE_URL / REDIS_URL or the defaults
	c.UserSvcURL = userSvc
	c.ConvSvcURL = convSvc
	c.AgentSvcURL = agentSvc
	c.DevAuthEnabled = true
	return c
}

func newServerT(t *testing.T, cfg Config) *Server {
	t.Helper()
	s, err := NewServer(cfg)
	if err != nil {
		t.Fatalf("NewServer: %v (is Postgres on 5433 and Redis on 6379 up?)", err)
	}
	return s
}

// login mints a token for a fresh, unique dev user so rate-limit buckets and
// user ids do not collide across tests.
func login(t *testing.T, app interface {
	Test(*http.Request, ...int) (*http.Response, error)
}, email string) (token, userID string) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"email": email})
	req := httptest.NewRequest(http.MethodPost, "/auth/dev-login", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req, 5000)
	if err != nil {
		t.Fatalf("dev-login: %v", err)
	}
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("dev-login status %d: %s", resp.StatusCode, b)
	}
	var out struct {
		Token string `json:"token"`
		User  User   `json:"user"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	if out.Token == "" || out.User.ID == "" {
		t.Fatalf("dev-login returned empty token/user: %+v", out)
	}
	return out.Token, out.User.ID
}

// Liveness must be 200 regardless of downstream health — its upstreams here all
// point at a dead address, and it must still report ok.
func TestHealthzLiveness(t *testing.T) {
	cfg := testConfig("http://127.0.0.1:1", "http://127.0.0.1:1", "http://127.0.0.1:1")
	app := newServerT(t, cfg).BuildApp()

	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("healthz status = %d, want 200", resp.StatusCode)
	}
	var out struct {
		Status string `json:"status"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	if out.Status != "ok" {
		t.Fatalf("liveness status = %q, want ok", out.Status)
	}
}

// Readiness probes dependencies and reports them. Redis is up in the test env,
// so it must be "ready" with deps populated.
func TestReadyz(t *testing.T) {
	cfg := testConfig("http://127.0.0.1:1", "http://127.0.0.1:1", "http://127.0.0.1:1")
	app := newServerT(t, cfg).BuildApp()

	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		Status string            `json:"status"`
		Deps   map[string]string `json:"deps"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	for _, k := range []string{"redis", "user_svc", "conv_svc", "agent_svc"} {
		if _, ok := out.Deps[k]; !ok {
			t.Fatalf("readyz deps missing %q: %+v", k, out.Deps)
		}
	}
	// Redis is up in CI/dev -> ready + 200. If Redis were down we'd expect 503.
	if out.Deps["redis"] != "ok" {
		t.Fatalf("redis dep = %q, want ok (is Redis up?)", out.Deps["redis"])
	}
	if resp.StatusCode != 200 || out.Status != "ready" {
		t.Fatalf("readyz = %d %q, want 200 ready", resp.StatusCode, out.Status)
	}
}

func TestAuthRequiredOnApi(t *testing.T) {
	cfg := testConfig("http://127.0.0.1:1", "http://127.0.0.1:1", "http://127.0.0.1:1")
	app := newServerT(t, cfg).BuildApp()

	// No token → 401.
	resp, _ := app.Test(httptest.NewRequest(http.MethodGet, "/api/conversations", nil))
	if resp.StatusCode != 401 {
		t.Fatalf("no-token status = %d, want 401", resp.StatusCode)
	}

	// Garbage token → 401.
	req := httptest.NewRequest(http.MethodGet, "/api/conversations", nil)
	req.Header.Set("Authorization", "Bearer not-a-jwt")
	resp, _ = app.Test(req)
	if resp.StatusCode != 401 {
		t.Fatalf("bad-token status = %d, want 401", resp.StatusCode)
	}
}

func TestConversationsInjectsUserID(t *testing.T) {
	var gotPath, gotQuery, gotBody string
	conv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	}))
	defer conv.Close()

	cfg := testConfig("http://127.0.0.1:1", conv.URL, "http://127.0.0.1:1")
	app := newServerT(t, cfg).BuildApp()
	token, uid := login(t, app, fmt.Sprintf("conv-%d@raphael.local", time.Now().UnixNano()))

	// POST with a SPOOFED user_id in the body — the gateway must overwrite it.
	body, _ := json.Marshal(map[string]any{"title": "hi", "user_id": "11111111-1111-1111-1111-111111111111"})
	req := httptest.NewRequest(http.MethodPost, "/api/conversations", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := app.Test(req, 5000)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if gotPath != "/conversations" {
		t.Fatalf("upstream path = %q, want /conversations", gotPath)
	}
	if !strings.Contains(gotQuery, "user_id="+uid) {
		t.Fatalf("query = %q, want user_id=%s", gotQuery, uid)
	}
	var forwarded map[string]any
	json.Unmarshal([]byte(gotBody), &forwarded)
	if forwarded["user_id"] != uid {
		t.Fatalf("body user_id = %v, want %s (spoof not overwritten)", forwarded["user_id"], uid)
	}
}

// TestInternalUnreachable proves that no path through the gateway reaches
// user-svc's /internal/* endpoints.
func TestInternalUnreachable(t *testing.T) {
	var internalHits int32
	var credHits int32
	user := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/internal/") {
			atomic.AddInt32(&internalHits, 1)
		}
		if strings.Contains(r.URL.Path, "/credentials") {
			atomic.AddInt32(&credHits, 1)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[]`))
	}))
	defer user.Close()

	cfg := testConfig(user.URL, "http://127.0.0.1:1", "http://127.0.0.1:1")
	app := newServerT(t, cfg).BuildApp()
	token, _ := login(t, app, fmt.Sprintf("intl-%d@raphael.local", time.Now().UnixNano()))

	// A legit providers call SHOULD reach /credentials (sanity that upstream works).
	{
		req := httptest.NewRequest(http.MethodGet, "/api/providers", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		resp, _ := app.Test(req, 5000)
		if resp.StatusCode != 200 {
			t.Fatalf("GET /api/providers status = %d, want 200", resp.StatusCode)
		}
	}
	if atomic.LoadInt32(&credHits) == 0 {
		t.Fatal("legit providers call never reached user-svc credentials route")
	}

	// A battery of attempts to reach /internal/*. None may hit it.
	attacks := []string{
		"/api/internal/users/00000000-0000-0000-0000-000000000001/credential/active",
		"/api/providers/../internal/users/1/credential/active",
		"/api/providers/internal/users/1/credential/active",
		"/api/providers/../../internal/users/1/credential/active",
		"/api/users/1/credential/active",
	}
	for _, p := range attacks {
		req := httptest.NewRequest(http.MethodGet, p, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := app.Test(req, 5000)
		if err != nil {
			continue
		}
		// Whatever the status, it must never have decrypted-credential intent.
		if resp.StatusCode == 200 {
			b, _ := io.ReadAll(resp.Body)
			// A 200 is only acceptable for the legit /credentials shape ([]).
			if strings.Contains(string(b), "api_key") {
				t.Fatalf("attack %q returned a key: %s", p, b)
			}
		}
	}
	if got := atomic.LoadInt32(&internalHits); got != 0 {
		t.Fatalf("user-svc /internal/* was hit %d times through the gateway", got)
	}
}

func TestRateLimit(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`[]`))
	}))
	defer up.Close()

	cfg := testConfig(up.URL, "http://127.0.0.1:1", "http://127.0.0.1:1")
	app := newServerT(t, cfg).BuildApp()
	// Unique user → isolated rate bucket.
	token, _ := login(t, app, fmt.Sprintf("rl-%d@raphael.local", time.Now().UnixNano()))

	var got429 bool
	for i := 0; i < 65; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/providers", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := app.Test(req, 5000)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode == 429 {
			got429 = true
			if i < 60 {
				t.Fatalf("rate limited too early at request %d", i+1)
			}
			break
		}
	}
	if !got429 {
		t.Fatal("never rate limited after 65 requests, want 429 past 60")
	}
}

// TestChatSSEStreamsIncrementally proves the gateway forwards SSE events as they
// arrive, flushing each one, rather than buffering the whole response. It uses a
// real TCP listener because in-memory transports can hide buffering.
func TestChatSSEStreamsIncrementally(t *testing.T) {
	// Fake agent-svc that emits 3 events with 150ms gaps between them.
	agent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Confirm the gateway injected user_id from the JWT.
		var in map[string]any
		json.NewDecoder(r.Body).Decode(&in)
		if in["user_id"] == nil || in["user_id"] == "" {
			t.Errorf("agent-svc received no user_id: %+v", in)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		fl, ok := w.(http.Flusher)
		if !ok {
			t.Error("agent test server cannot flush")
			return
		}
		for i := 0; i < 3; i++ {
			fmt.Fprintf(w, "event: token\ndata: {\"text\":\"tok%d\"}\n\n", i)
			fl.Flush()
			time.Sleep(150 * time.Millisecond)
		}
		fmt.Fprint(w, "event: done\ndata: {}\n\n")
		fl.Flush()
	}))
	defer agent.Close()

	cfg := testConfig("http://127.0.0.1:1", "http://127.0.0.1:1", agent.URL)
	srv := newServerT(t, cfg)
	app := srv.BuildApp()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go app.Listener(ln)
	defer app.Shutdown()
	base := "http://" + ln.Addr().String()

	// Log in via the real listener.
	token, _ := login(t, app, fmt.Sprintf("sse-%d@raphael.local", time.Now().UnixNano()))

	body, _ := json.Marshal(map[string]string{"conversation_id": "c1", "message": "hi"})
	req, _ := http.NewRequest(http.MethodPost, base+"/api/chat", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("content-type = %q, want text/event-stream", ct)
	}

	start := time.Now()
	var arrivals []time.Duration
	var events []string
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "data:") {
			arrivals = append(arrivals, time.Since(start))
			events = append(events, line)
		}
	}
	if len(events) < 4 {
		t.Fatalf("got %d data events, want >=4: %v", len(events), events)
	}
	// Incremental proof: the gap between the first and last event must reflect
	// the server's 150ms-per-event pacing. If the gateway buffered, all arrivals
	// would cluster at the end (spread ~0).
	spread := arrivals[len(arrivals)-1] - arrivals[0]
	if spread < 250*time.Millisecond {
		t.Fatalf("events arrived within %v — looks buffered, not streamed: %v", spread, arrivals)
	}
	t.Logf("SSE arrivals: %v (spread %v)", arrivals, spread)
}
