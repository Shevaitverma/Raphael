package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
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
	c.InternalToken = "test-internal-secret" // so /internal/chat's valid-token case works
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

// TestDeleteConversationForcesJWTUID proves DELETE /api/conversations/<id>
// reaches conv-svc at /conversations/<id> with method DELETE and ?user_id=<jwt
// uid> forced — a spoofed user_id in the query must not survive. Fails against
// pre-change code: the route did not exist (405).
func TestDeleteConversationForcesJWTUID(t *testing.T) {
	var gotPath, gotMethod, gotQuery string
	conv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotMethod = r.Method
		gotQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"deleted":true}`))
	}))
	defer conv.Close()

	cfg := testConfig("http://127.0.0.1:1", conv.URL, "http://127.0.0.1:1")
	app := newServerT(t, cfg).BuildApp()
	token, uid := login(t, app, fmt.Sprintf("del-%d@raphael.local", time.Now().UnixNano()))

	convID := "88888888-8888-8888-8888-888888888888"
	spoof := "11111111-1111-1111-1111-111111111111"
	req := httptest.NewRequest(http.MethodDelete,
		"/api/conversations/"+convID+"?user_id="+spoof, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := app.Test(req, 5000)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("DELETE /api/conversations/<id> status = %d, want 200", resp.StatusCode)
	}
	if want := "/conversations/" + convID; gotPath != want {
		t.Fatalf("upstream path = %q, want %q", gotPath, want)
	}
	if gotMethod != http.MethodDelete {
		t.Fatalf("upstream method = %q, want DELETE", gotMethod)
	}
	// EXACTLY the JWT uid must reach conv-svc — the spoof must not survive.
	q, err := url.ParseQuery(gotQuery)
	if err != nil {
		t.Fatalf("upstream query %q unparseable: %v", gotQuery, err)
	}
	if got := q["user_id"]; len(got) != 1 || got[0] != uid {
		t.Fatalf("upstream user_id = %v, want exactly [%s] (spoof leaked?)", got, uid)
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

// TestTasksForcesJWTUID proves the tasks CRUD proxy roots every target at
// /users/<jwt-uid>/tasks: GET lists at the JWT uid; PATCH /api/tasks/<id>
// reaches /users/<jwt-uid>/tasks/<id> with method PATCH and the body forwarded;
// and a spoofed uid in the path does not change the forwarded uid. Fails against
// pre-change code: the routes did not exist (404).
func TestTasksForcesJWTUID(t *testing.T) {
	var gotPath, gotMethod, gotBody string
	user := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotMethod = r.Method
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	}))
	defer user.Close()

	cfg := testConfig(user.URL, "http://127.0.0.1:1", "http://127.0.0.1:1")
	app := newServerT(t, cfg).BuildApp()
	token, uid := login(t, app, fmt.Sprintf("task-%d@raphael.local", time.Now().UnixNano()))

	// GET must land on /users/<jwt-uid>/tasks.
	{
		req := httptest.NewRequest(http.MethodGet, "/api/tasks", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := app.Test(req, 5000)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != 200 {
			t.Fatalf("GET /api/tasks status = %d, want 200", resp.StatusCode)
		}
		if want := "/users/" + uid + "/tasks"; gotPath != want {
			t.Fatalf("GET upstream path = %q, want %q", gotPath, want)
		}
		if gotMethod != http.MethodGet {
			t.Fatalf("GET upstream method = %q, want GET", gotMethod)
		}
	}

	// PATCH /api/tasks/<id> must reach /users/<jwt-uid>/tasks/<id> with PATCH and
	// forward the body.
	{
		taskID := "77777777-7777-7777-7777-777777777777"
		body, _ := json.Marshal(map[string]any{"done": true})
		req := httptest.NewRequest(http.MethodPatch, "/api/tasks/"+taskID, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := app.Test(req, 5000)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != 200 {
			t.Fatalf("PATCH /api/tasks/<id> status = %d, want 200", resp.StatusCode)
		}
		if want := "/users/" + uid + "/tasks/" + taskID; gotPath != want {
			t.Fatalf("PATCH upstream path = %q, want %q", gotPath, want)
		}
		if gotMethod != http.MethodPatch {
			t.Fatalf("PATCH upstream method = %q, want PATCH", gotMethod)
		}
		if !strings.Contains(gotBody, "done") {
			t.Fatalf("PATCH upstream body = %q, want it to carry the body", gotBody)
		}
	}

	// A spoofed uid in the path must not retarget: /api/tasks routes ignore any
	// client uid, the target is always rooted at the JWT uid.
	{
		spoof := "11111111-1111-1111-1111-111111111111"
		req := httptest.NewRequest(http.MethodGet, "/api/tasks?user_id="+spoof, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := app.Test(req, 5000)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != 200 {
			t.Fatalf("spoof GET status = %d, want 200", resp.StatusCode)
		}
		if want := "/users/" + uid + "/tasks"; gotPath != want {
			t.Fatalf("spoof upstream path = %q, want %q (spoofed uid must not retarget)", gotPath, want)
		}
	}
}

// TestMemoryGraphForcesJWTUID proves GET /api/memory/graph reaches agent-svc at
// /memory/graph with ?user_id=<jwt uid> forced from the JWT. A spoofed user_id
// in the request query must not change the forwarded uid. Fails against
// pre-change code: the route did not exist (404).
func TestMemoryGraphForcesJWTUID(t *testing.T) {
	var gotPath, gotQuery string
	agent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"nodes":[]}`))
	}))
	defer agent.Close()

	cfg := testConfig("http://127.0.0.1:1", "http://127.0.0.1:1", agent.URL)
	app := newServerT(t, cfg).BuildApp()
	token, uid := login(t, app, fmt.Sprintf("mem-%d@raphael.local", time.Now().UnixNano()))

	// Spoof a user_id in the query — it must be ignored, the JWT uid forwarded.
	spoof := "11111111-1111-1111-1111-111111111111"
	req := httptest.NewRequest(http.MethodGet, "/api/memory/graph?user_id="+spoof, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := app.Test(req, 5000)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if gotPath != "/memory/graph" {
		t.Fatalf("upstream path = %q, want /memory/graph", gotPath)
	}
	// EXACTLY the JWT uid must reach agent-svc — the spoof must not survive.
	q, err := url.ParseQuery(gotQuery)
	if err != nil {
		t.Fatalf("upstream query %q unparseable: %v", gotQuery, err)
	}
	if got := q["user_id"]; len(got) != 1 || got[0] != uid {
		t.Fatalf("upstream user_id = %v, want exactly [%s] (spoof leaked?)", got, uid)
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

// TestInternalChat proves the trusted internal chat-ingress: it is secret-gated
// (no token and a wrong token both get 401 with no pipeline call), and on the
// right token it reaches agent-svc with the BODY-supplied user_id (no JWT). It
// sits outside the /api JWT group. Fails against pre-change code: the route did
// not exist (404/405).
func TestInternalChat(t *testing.T) {
	var agentHits int32
	var gotUserID string
	agent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&agentHits, 1)
		var in map[string]any
		json.NewDecoder(r.Body).Decode(&in)
		if v, ok := in["user_id"].(string); ok {
			gotUserID = v
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		fmt.Fprint(w, "event: done\ndata: {}\n\n")
	}))
	defer agent.Close()

	cfg := testConfig("http://127.0.0.1:1", "http://127.0.0.1:1", agent.URL)
	app := newServerT(t, cfg).BuildApp()

	bodyUID := "22222222-2222-2222-2222-222222222222"
	newReq := func(token string) *http.Request {
		body, _ := json.Marshal(map[string]any{
			"user_id":         bodyUID,
			"conversation_id": "33333333-3333-3333-3333-333333333333",
			"message":         "hi from whatsapp",
		})
		req := httptest.NewRequest(http.MethodPost, "/internal/chat", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("X-Internal-Token", token)
		}
		return req
	}

	// No token → 401, no pipeline call.
	resp, err := app.Test(newReq(""), 5000)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 401 {
		t.Fatalf("no-token status = %d, want 401", resp.StatusCode)
	}

	// Wrong token → 401, no pipeline call.
	resp, err = app.Test(newReq("nope-wrong-secret"), 5000)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 401 {
		t.Fatalf("wrong-token status = %d, want 401", resp.StatusCode)
	}
	if got := atomic.LoadInt32(&agentHits); got != 0 {
		t.Fatalf("agent-svc was called %d times without a valid token", got)
	}

	// Right token → 200, and agent-svc receives the BODY user_id.
	resp, err = app.Test(newReq(cfg.InternalToken), 5000)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("valid-token status = %d, want 200", resp.StatusCode)
	}
	if atomic.LoadInt32(&agentHits) != 1 {
		t.Fatalf("agent-svc hits = %d, want 1", agentHits)
	}
	if gotUserID != bodyUID {
		t.Fatalf("agent-svc user_id = %q, want body-supplied %q", gotUserID, bodyUID)
	}
}

// TestGoogleState is the load-bearing security test: signState/verifyState must
// round-trip, and verifyState must REJECT a state whose payload was swapped, a
// state with a single flipped byte, and an expired state. Each rejection is the
// CSRF + identity boundary — the callback trusts uid ONLY from a state that
// survives all three. Fails against pre-change code: the methods did not exist.
func TestGoogleState(t *testing.T) {
	cfg := testConfig("http://127.0.0.1:1", "http://127.0.0.1:1", "http://127.0.0.1:1")
	srv := newServerT(t, cfg)

	uid := "44444444-4444-4444-4444-444444444444"
	state, err := srv.signState(uid)
	if err != nil {
		t.Fatalf("signState: %v", err)
	}

	// Round-trip.
	if got, ok := srv.verifyState(state); !ok || got != uid {
		t.Fatalf("verifyState round-trip = (%q,%v), want (%q,true)", got, ok, uid)
	}

	// Tampered payload (swap the uid, keep the original MAC) must be rejected —
	// this is exactly the forge-another-user attack.
	{
		p, sig, _ := strings.Cut(state, ".")
		raw, _ := base64.RawURLEncoding.DecodeString(p)
		var sp statePayload
		json.Unmarshal(raw, &sp)
		sp.UID = "99999999-9999-9999-9999-999999999999"
		swapped, _ := json.Marshal(sp)
		tampered := base64.RawURLEncoding.EncodeToString(swapped) + "." + sig
		if got, ok := srv.verifyState(tampered); ok {
			t.Fatalf("verifyState accepted a swapped-uid state (got %q) — MAC does not bind the payload", got)
		}
	}

	// Single flipped byte anywhere must fail the MAC.
	{
		b := []byte(state)
		b[len(b)-1] ^= 0x01
		if _, ok := srv.verifyState(string(b)); ok {
			t.Fatal("verifyState accepted a state with a flipped byte")
		}
	}

	// Expired state (valid MAC, past exp) must be rejected — no replay.
	{
		payload, _ := json.Marshal(statePayload{
			UID: uid, Exp: time.Now().Add(-time.Minute).Unix(), Nonce: "n",
		})
		expired := base64.RawURLEncoding.EncodeToString(payload) + "." +
			base64.RawURLEncoding.EncodeToString(srv.stateMAC(payload))
		if _, ok := srv.verifyState(expired); ok {
			t.Fatal("verifyState accepted an expired state — replay past exp is possible")
		}
	}
}

// TestGoogleConnect proves connect fails closed (503) when unconfigured, and
// once configured returns a JSON auth_url carrying the client_id and a state.
func TestGoogleConnect(t *testing.T) {
	// Unconfigured (no GOOGLE_CLIENT_ID) → 503, never a panic.
	{
		cfg := testConfig("http://127.0.0.1:1", "http://127.0.0.1:1", "http://127.0.0.1:1")
		cfg.GoogleClientID = ""
		app := newServerT(t, cfg).BuildApp()
		token, _ := login(t, app, fmt.Sprintf("gc0-%d@raphael.local", time.Now().UnixNano()))

		req := httptest.NewRequest(http.MethodGet, "/api/google/connect", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := app.Test(req, 5000)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != 503 {
			t.Fatalf("unconfigured connect status = %d, want 503", resp.StatusCode)
		}
	}

	// Configured → 200 with an auth_url containing the client_id and a state.
	{
		cfg := testConfig("http://127.0.0.1:1", "http://127.0.0.1:1", "http://127.0.0.1:1")
		cfg.GoogleClientID = "test-client-id.apps.googleusercontent.com"
		app := newServerT(t, cfg).BuildApp()
		token, _ := login(t, app, fmt.Sprintf("gc1-%d@raphael.local", time.Now().UnixNano()))

		req := httptest.NewRequest(http.MethodGet, "/api/google/connect", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := app.Test(req, 5000)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != 200 {
			t.Fatalf("configured connect status = %d, want 200", resp.StatusCode)
		}
		var out struct {
			AuthURL string `json:"auth_url"`
		}
		json.NewDecoder(resp.Body).Decode(&out)
		u, err := url.Parse(out.AuthURL)
		if err != nil {
			t.Fatalf("auth_url unparseable: %v", err)
		}
		q := u.Query()
		if q.Get("client_id") != cfg.GoogleClientID {
			t.Fatalf("auth_url client_id = %q, want %q", q.Get("client_id"), cfg.GoogleClientID)
		}
		if q.Get("state") == "" {
			t.Fatal("auth_url has no state")
		}
		// The state must verify — connect and callback share the same secret.
		if _, ok := newServerT(t, cfg).verifyState(q.Get("state")); !ok {
			t.Fatal("auth_url state does not verify")
		}
	}
}

// TestGoogleCallback proves the public callback: a VALID state forwards the code
// to user-svc's internal exchange (with the shared secret) and 302s to
// WEB_ORIGIN/?google=connected; a BAD state neither calls user-svc nor 302s to
// success. Fails against pre-change code: the route did not exist.
func TestGoogleCallback(t *testing.T) {
	var exchangeHits int32
	var gotPath, gotCode, gotSecret string
	user := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&exchangeHits, 1)
		gotPath = r.URL.Path
		gotSecret = r.Header.Get("X-Internal-Token")
		var in map[string]string
		json.NewDecoder(r.Body).Decode(&in)
		gotCode = in["code"]
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"email":"u@example.com","scopes":"calendar.readonly"}`))
	}))
	defer user.Close()

	cfg := testConfig(user.URL, "http://127.0.0.1:1", "http://127.0.0.1:1")
	srv := newServerT(t, cfg)
	app := srv.BuildApp()

	uid := "55555555-5555-5555-5555-555555555555"
	state, err := srv.signState(uid)
	if err != nil {
		t.Fatalf("signState: %v", err)
	}

	// Valid state → exchange called, 302 to WEB_ORIGIN connected.
	{
		req := httptest.NewRequest(http.MethodGet,
			"/auth/google/callback?code=the-auth-code&state="+url.QueryEscape(state), nil)
		resp, err := app.Test(req, 5000)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != 302 {
			t.Fatalf("valid callback status = %d, want 302", resp.StatusCode)
		}
		loc := resp.Header.Get("Location")
		if loc != cfg.WebOrigin+"/?google=connected" {
			t.Fatalf("valid callback Location = %q, want %q", loc, cfg.WebOrigin+"/?google=connected")
		}
		if strings.Contains(loc, "token") || strings.Contains(loc, "the-auth-code") {
			t.Fatalf("redirect leaked a secret: %q", loc)
		}
		if atomic.LoadInt32(&exchangeHits) != 1 {
			t.Fatalf("exchange hits = %d, want 1", exchangeHits)
		}
		if want := "/internal/users/" + uid + "/google/exchange"; gotPath != want {
			t.Fatalf("exchange path = %q, want %q", gotPath, want)
		}
		if gotCode != "the-auth-code" {
			t.Fatalf("exchange code = %q, want the-auth-code", gotCode)
		}
		if gotSecret != cfg.InternalToken {
			t.Fatalf("exchange X-Internal-Token = %q, want %q", gotSecret, cfg.InternalToken)
		}
	}

	// Bad state → NO exchange call, and NOT a success redirect.
	{
		before := atomic.LoadInt32(&exchangeHits)
		req := httptest.NewRequest(http.MethodGet,
			"/auth/google/callback?code=the-auth-code&state=forged.garbage", nil)
		resp, err := app.Test(req, 5000)
		if err != nil {
			t.Fatal(err)
		}
		if atomic.LoadInt32(&exchangeHits) != before {
			t.Fatal("bad state still reached user-svc exchange")
		}
		if resp.StatusCode == 302 {
			if loc := resp.Header.Get("Location"); strings.Contains(loc, "google=connected") {
				t.Fatalf("bad state 302'd to success: %q", loc)
			}
		}
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
