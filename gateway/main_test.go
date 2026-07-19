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
	"net/url"
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

	// POST with a SPOOFED user_id in BOTH the body and the query — the gateway
	// must overwrite each. The query half is the regression guard for the bug
	// where the gateway appended user_id instead of setting it: url.Values.Get
	// returns the FIRST value, so a client-supplied one won.
	body, _ := json.Marshal(map[string]any{"title": "hi", "user_id": "11111111-1111-1111-1111-111111111111"})
	req := httptest.NewRequest(http.MethodPost,
		"/api/conversations?user_id=11111111-1111-1111-1111-111111111111", bytes.NewReader(body))
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
	// EXACTLY one user_id must reach upstream. len(got) != 1 is the load-bearing
	// half: a Contains() check passes against the appending (vulnerable) code.
	q, err := url.ParseQuery(gotQuery)
	if err != nil {
		t.Fatalf("upstream query %q is unparseable: %v", gotQuery, err)
	}
	if got := q["user_id"]; len(got) != 1 || got[0] != uid {
		t.Fatalf("upstream user_id = %v, want exactly [%s]", got, uid)
	}
	var forwarded map[string]any
	json.Unmarshal([]byte(gotBody), &forwarded)
	if forwarded["user_id"] != uid {
		t.Fatalf("body user_id = %v, want %s (spoof not overwritten)", forwarded["user_id"], uid)
	}
}

// TestProfileForcesJWTUID proves GET/PUT /api/profile reach user-svc at
// /users/<jwt-uid>/profile with the uid forced from the JWT. A client cannot
// retarget another user's profile via the path.
func TestProfileForcesJWTUID(t *testing.T) {
	var gotPath, gotMethod, gotBody string
	user := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotMethod = r.Method
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"assistant_name":"Raphael"}`))
	}))
	defer user.Close()

	cfg := testConfig(user.URL, "http://127.0.0.1:1", "http://127.0.0.1:1")
	app := newServerT(t, cfg).BuildApp()
	token, uid := login(t, app, fmt.Sprintf("prof-%d@raphael.local", time.Now().UnixNano()))

	// GET must land on /users/<jwt-uid>/profile.
	{
		req := httptest.NewRequest(http.MethodGet, "/api/profile", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := app.Test(req, 5000)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != 200 {
			t.Fatalf("GET /api/profile status = %d, want 200", resp.StatusCode)
		}
		if want := "/users/" + uid + "/profile"; gotPath != want {
			t.Fatalf("GET upstream path = %q, want %q", gotPath, want)
		}
		if gotMethod != http.MethodGet {
			t.Fatalf("GET upstream method = %q, want GET", gotMethod)
		}
	}

	// PUT with a SPOOFED uid in the body must still target the JWT uid's profile.
	// The gateway roots the path at the JWT uid; the body is forwarded verbatim to
	// user-svc, which itself keys off the path — so the spoof cannot retarget.
	{
		spoof := "11111111-1111-1111-1111-111111111111"
		body, _ := json.Marshal(map[string]any{"assistant_name": "Jarvis", "user_id": spoof})
		req := httptest.NewRequest(http.MethodPut, "/api/profile", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := app.Test(req, 5000)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != 200 {
			t.Fatalf("PUT /api/profile status = %d, want 200", resp.StatusCode)
		}
		if want := "/users/" + uid + "/profile"; gotPath != want {
			t.Fatalf("PUT upstream path = %q, want %q (spoofed uid must not retarget)", gotPath, want)
		}
		if gotMethod != http.MethodPut {
			t.Fatalf("PUT upstream method = %q, want PUT", gotMethod)
		}
		if !strings.Contains(gotBody, "Jarvis") {
			t.Fatalf("PUT upstream body = %q, want it to carry assistant_name", gotBody)
		}
	}
}

// TestChatInjectsAssistantName proves handleChat adds an assistant_name to the
// agent-svc payload, taken from the DB (JWT-keyed) and defaulting to "Raphael"
// when the lookup finds nothing. It also proves a client-supplied assistant_name
// in the chat body is dropped, not trusted.
func TestChatInjectsAssistantName(t *testing.T) {
	var gotName any
	var namePresent bool
	agent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in map[string]any
		json.NewDecoder(r.Body).Decode(&in)
		gotName, namePresent = in["assistant_name"]
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		fmt.Fprint(w, "event: done\ndata: {}\n\n")
	}))
	defer agent.Close()

	cfg := testConfig("http://127.0.0.1:1", "http://127.0.0.1:1", agent.URL)
	app := newServerT(t, cfg).BuildApp()
	// A fresh dev user; db/004 defaults assistant_name to 'Raphael', so the
	// JWT-keyed lookup returns that default.
	token, _ := login(t, app, fmt.Sprintf("chatname-%d@raphael.local", time.Now().UnixNano()))

	// Client tries to spoof a name in the body; it must be dropped and replaced by
	// the DB value.
	body, _ := json.Marshal(map[string]any{
		"conversation_id": "c1", "message": "hi", "assistant_name": "EvilBot",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/chat", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := app.Test(req, 5000)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("chat status = %d, want 200", resp.StatusCode)
	}
	if !namePresent {
		t.Fatal("agent-svc payload missing assistant_name")
	}
	if gotName == "EvilBot" {
		t.Fatalf("assistant_name = %v, client body was trusted (must come from DB)", gotName)
	}
	if gotName != "Raphael" {
		t.Fatalf("assistant_name = %v, want DB default \"Raphael\"", gotName)
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
