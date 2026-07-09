package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// A fixed 32-byte base64 key for tests only. Never a real secret.
const testEncKey = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="

// testUserID is a stable uuid distinct from the seeded dev user.
const testUserID = "00000000-0000-0000-0000-0000000000ff"

var (
	testPool *pgxpool.Pool
	haveDB   bool
)

func TestMain(m *testing.M) {
	dbURL := getenv("DATABASE_URL", "postgresql://raphael:raphael@localhost:5433/raphael")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if pool, err := pgxpool.New(ctx, dbURL); err == nil {
		if err := pool.Ping(ctx); err == nil {
			testPool = pool
			haveDB = true
			// Ensure a clean test user with no leftover credentials.
			_, _ = pool.Exec(ctx, `DELETE FROM provider_credentials WHERE user_id = $1`, testUserID)
			_, _ = pool.Exec(ctx,
				`INSERT INTO users (id, email, name) VALUES ($1, 'usersvc-test@raphael.local', 'Test User')
				 ON CONFLICT (id) DO NOTHING`, testUserID)
		}
	}
	code := m.Run()
	if haveDB {
		ctx2, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
		_, _ = testPool.Exec(ctx2, `DELETE FROM provider_credentials WHERE user_id = $1`, testUserID)
		cancel2()
		testPool.Close()
	}
	os.Exit(code)
}

func newTestServer(t *testing.T) *server {
	t.Helper()
	if !haveDB {
		t.Skip("Postgres not reachable at DATABASE_URL; skipping DB-backed test")
	}
	// Clean this user's credentials before each test for isolation.
	_, err := testPool.Exec(context.Background(),
		`DELETE FROM provider_credentials WHERE user_id = $1`, testUserID)
	if err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	cr, err := newCryptor(testEncKey)
	if err != nil {
		t.Fatalf("cryptor: %v", err)
	}
	return &server{store: &store{pool: testPool, crypto: cr}}
}

func do(t *testing.T, srv *server, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatalf("encode: %v", err)
		}
	}
	req := httptest.NewRequest(method, path, &buf)
	rec := httptest.NewRecorder()
	srv.routes().ServeHTTP(rec, req)
	return rec
}

// --- unit: crypto roundtrip (no DB) ----------------------------------------

func TestCryptoRoundTrip(t *testing.T) {
	cr, err := newCryptor(testEncKey)
	if err != nil {
		t.Fatal(err)
	}
	secret := "sk-ant-supersecret-000"
	blob, err := cr.encrypt(secret)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(blob, []byte(secret)) {
		t.Fatal("ciphertext contains plaintext")
	}
	got, err := cr.decrypt(blob)
	if err != nil {
		t.Fatal(err)
	}
	if got != secret {
		t.Fatalf("roundtrip mismatch: %q", got)
	}
}

func TestCryptoRejectsBadKey(t *testing.T) {
	if _, err := newCryptor(""); err == nil {
		t.Fatal("expected error on empty key")
	}
	if _, err := newCryptor("dG9vLXNob3J0"); err == nil {
		t.Fatal("expected error on short key")
	}
}

// --- public response never leaks the plaintext key -------------------------

func TestPublicResponseNeverContainsKey(t *testing.T) {
	srv := newTestServer(t)
	const secret = "sk-ant-PLAINTEXT-MUST-NOT-LEAK-42"

	// Create with a key.
	rec := do(t, srv, http.MethodPost, "/users/"+testUserID+"/credentials", createCredentialReq{
		Provider: "anthropic", AuthType: "api_key", APIKey: secret,
		ModelID: "claude-opus-4-8", Activate: true,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: got %d body=%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), secret) {
		t.Fatalf("create response leaked the key: %s", rec.Body.String())
	}
	// Also ensure no api_key field at all.
	var created map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &created)
	if _, ok := created["api_key"]; ok {
		t.Fatal("create response has an api_key field")
	}

	// List must not leak either.
	rec = do(t, srv, http.MethodGet, "/users/"+testUserID+"/credentials", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("list: got %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), secret) {
		t.Fatalf("list response leaked the key: %s", rec.Body.String())
	}

	// The internal route SHOULD return the decrypted key (proves it was stored).
	rec = do(t, srv, http.MethodGet, "/internal/users/"+testUserID+"/credential/active", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("internal active: got %d body=%s", rec.Code, rec.Body.String())
	}
	var d decryptedCredential
	if err := json.Unmarshal(rec.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	if d.APIKey != secret {
		t.Fatalf("internal active did not return the decrypted key: %q", d.APIKey)
	}
}

// --- activating a second credential deactivates the first ------------------

func TestActivateSecondDeactivatesFirst(t *testing.T) {
	srv := newTestServer(t)

	// First active credential: local.
	rec := do(t, srv, http.MethodPost, "/users/"+testUserID+"/credentials", createCredentialReq{
		Provider: "local", AuthType: "api_key", ModelID: "qwen2.5:7b", Activate: true,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create local: %d body=%s", rec.Code, rec.Body.String())
	}
	var first credential
	_ = json.Unmarshal(rec.Body.Bytes(), &first)

	// Second credential, inactive: anthropic.
	rec = do(t, srv, http.MethodPost, "/users/"+testUserID+"/credentials", createCredentialReq{
		Provider: "anthropic", AuthType: "api_key", APIKey: "sk-ant-x",
		ModelID: "claude-opus-4-8", Activate: false,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create anthropic: %d body=%s", rec.Code, rec.Body.String())
	}
	var second credential
	_ = json.Unmarshal(rec.Body.Bytes(), &second)

	// Activate the second — the first must be deactivated, no 409.
	rec = do(t, srv, http.MethodPost,
		"/users/"+testUserID+"/credentials/"+second.ID+"/activate", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("activate second: %d body=%s", rec.Code, rec.Body.String())
	}

	// Exactly one active row, and it is the second.
	rec = do(t, srv, http.MethodGet, "/users/"+testUserID+"/credentials", nil)
	var listed struct {
		Credentials []credential `json:"credentials"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &listed)
	active := 0
	for _, c := range listed.Credentials {
		if c.IsActive {
			active++
			if c.ID != second.ID {
				t.Fatalf("wrong credential active: %s", c.ID)
			}
		}
	}
	if active != 1 {
		t.Fatalf("expected exactly 1 active credential, got %d", active)
	}

	// Internal active must now resolve to the anthropic row.
	rec = do(t, srv, http.MethodGet, "/internal/users/"+testUserID+"/credential/active", nil)
	var d decryptedCredential
	_ = json.Unmarshal(rec.Body.Bytes(), &d)
	if d.Provider != "anthropic" {
		t.Fatalf("expected active provider anthropic, got %s", d.Provider)
	}
}

// --- oauth is only valid for anthropic -> clean 409 ------------------------

func TestOauthNonAnthropicRejected(t *testing.T) {
	srv := newTestServer(t)
	rec := do(t, srv, http.MethodPost, "/users/"+testUserID+"/credentials", createCredentialReq{
		Provider: "openai_compat", AuthType: "oauth", ModelID: "x", Activate: false,
	})
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d body=%s", rec.Code, rec.Body.String())
	}
}

// --- lifeboat: local row, or 204 when absent -------------------------------

func TestLifeboat(t *testing.T) {
	srv := newTestServer(t)

	// No local row yet -> 204.
	rec := do(t, srv, http.MethodGet, "/internal/users/"+testUserID+"/credential/lifeboat", nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204 when no local row, got %d", rec.Code)
	}

	// Add a local (inactive) row alongside an active anthropic one.
	_ = do(t, srv, http.MethodPost, "/users/"+testUserID+"/credentials", createCredentialReq{
		Provider: "anthropic", AuthType: "api_key", APIKey: "sk-ant-y",
		ModelID: "claude-opus-4-8", Activate: true,
	})
	_ = do(t, srv, http.MethodPost, "/users/"+testUserID+"/credentials", createCredentialReq{
		Provider: "local", AuthType: "api_key", ModelID: "qwen2.5:7b", Activate: false,
	})

	rec = do(t, srv, http.MethodGet, "/internal/users/"+testUserID+"/credential/lifeboat", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 lifeboat, got %d body=%s", rec.Code, rec.Body.String())
	}
	var d decryptedCredential
	_ = json.Unmarshal(rec.Body.Bytes(), &d)
	if d.Provider != "local" {
		t.Fatalf("lifeboat provider = %s, want local", d.Provider)
	}
}

// --- one row per (user, provider) -> clean 409 -----------------------------

func TestDuplicateProviderRejected(t *testing.T) {
	srv := newTestServer(t)
	body := createCredentialReq{Provider: "local", AuthType: "api_key", ModelID: "qwen2.5:7b"}
	if rec := do(t, srv, http.MethodPost, "/users/"+testUserID+"/credentials", body); rec.Code != http.StatusCreated {
		t.Fatalf("first create: %d", rec.Code)
	}
	rec := do(t, srv, http.MethodPost, "/users/"+testUserID+"/credentials", body)
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 on duplicate provider, got %d body=%s", rec.Code, rec.Body.String())
	}
}
