package main

import (
	"bytes"
	"context"
	"encoding/base64"
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
			_, _ = pool.Exec(ctx, `DELETE FROM google_credentials WHERE user_id = $1`, testUserID)
			_, _ = pool.Exec(ctx, `DELETE FROM tasks WHERE user_id = $1`, testUserID)
			_, _ = pool.Exec(ctx,
				`INSERT INTO users (id, email, name) VALUES ($1, 'usersvc-test@raphael.local', 'Test User')
				 ON CONFLICT (id) DO NOTHING`, testUserID)
		}
	}
	code := m.Run()
	if haveDB {
		ctx2, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
		_, _ = testPool.Exec(ctx2, `DELETE FROM provider_credentials WHERE user_id = $1`, testUserID)
		_, _ = testPool.Exec(ctx2, `DELETE FROM google_credentials WHERE user_id = $1`, testUserID)
		_, _ = testPool.Exec(ctx2, `DELETE FROM tasks WHERE user_id = $1`, testUserID)
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
	if _, err := testPool.Exec(context.Background(),
		`DELETE FROM google_credentials WHERE user_id = $1`, testUserID); err != nil {
		t.Fatalf("cleanup google: %v", err)
	}
	if _, err := testPool.Exec(context.Background(),
		`DELETE FROM tasks WHERE user_id = $1`, testUserID); err != nil {
		t.Fatalf("cleanup tasks: %v", err)
	}
	cr, err := newCryptor(testEncKey)
	if err != nil {
		t.Fatalf("cryptor: %v", err)
	}
	return &server{store: &store{pool: testPool, crypto: cr}, internalToken: testInternalToken}
}

const testInternalToken = "test-internal-token-0123456789"

func do(t *testing.T, srv *server, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatalf("encode: %v", err)
		}
	}
	req := httptest.NewRequest(method, path, &buf)
	// Internal routes require the shared secret; supply it for these tests.
	if strings.HasPrefix(path, "/internal/") {
		req.Header.Set("X-Internal-Token", testInternalToken)
	}
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

// --- lifeboat: the designated is_lifeboat row, or 204 when none ------------
// The lifeboat is whatever row is flagged is_lifeboat (not hardcoded to
// provider='local'), excluding the active row. Skeleton note: the designation
// is set here via SQL; a user-facing "make this my fallback" API/UI is Phase 2.
func TestLifeboat(t *testing.T) {
	srv := newTestServer(t)

	// No lifeboat designated yet -> 204.
	rec := do(t, srv, http.MethodGet, "/internal/users/"+testUserID+"/credential/lifeboat", nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204 when no lifeboat, got %d", rec.Code)
	}

	// Active anthropic + an inactive local row.
	_ = do(t, srv, http.MethodPost, "/users/"+testUserID+"/credentials", createCredentialReq{
		Provider: "anthropic", AuthType: "api_key", APIKey: "sk-ant-y",
		ModelID: "claude-opus-4-8", Activate: true,
	})
	_ = do(t, srv, http.MethodPost, "/users/"+testUserID+"/credentials", createCredentialReq{
		Provider: "local", AuthType: "api_key", ModelID: "qwen2.5:7b", Activate: false,
	})

	// Not a lifeboat until designated: still 204.
	rec = do(t, srv, http.MethodGet, "/internal/users/"+testUserID+"/credential/lifeboat", nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204 before designation, got %d", rec.Code)
	}

	// Designate the local row as the lifeboat.
	if _, err := testPool.Exec(context.Background(),
		`UPDATE provider_credentials SET is_lifeboat = true
		 WHERE user_id = $1 AND provider = 'local'`, testUserID); err != nil {
		t.Fatalf("designate lifeboat: %v", err)
	}

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

// --- designating / clearing the lifeboat -----------------------------------
func TestDesignateLifeboat(t *testing.T) {
	srv := newTestServer(t)

	// Active anthropic + two inactive rows (local, openai_compat).
	do(t, srv, http.MethodPost, "/users/"+testUserID+"/credentials", createCredentialReq{
		Provider: "anthropic", AuthType: "api_key", APIKey: "sk-ant-z",
		ModelID: "claude-opus-4-8", Activate: true,
	})
	recLocal := do(t, srv, http.MethodPost, "/users/"+testUserID+"/credentials", createCredentialReq{
		Provider: "local", AuthType: "api_key", ModelID: "qwen2.5:7b", Activate: false,
	})
	var local credential
	_ = json.Unmarshal(recLocal.Body.Bytes(), &local)
	recOR := do(t, srv, http.MethodPost, "/users/"+testUserID+"/credentials", createCredentialReq{
		Provider: "openai_compat", AuthType: "api_key", APIKey: "sk-or-x",
		BaseURL: strptr("https://openrouter.ai/api/v1"), ModelID: "meta/llama", Activate: false,
	})
	var openrouter credential
	_ = json.Unmarshal(recOR.Body.Bytes(), &openrouter)

	// Find the active anthropic id.
	var listed struct {
		Credentials []credential `json:"credentials"`
	}
	_ = json.Unmarshal(do(t, srv, http.MethodGet, "/users/"+testUserID+"/credentials", nil).Body.Bytes(), &listed)
	var anthropicID string
	for _, c := range listed.Credentials {
		if c.Provider == "anthropic" {
			anthropicID = c.ID
		}
	}

	// Designating the ACTIVE credential as the lifeboat -> 409.
	rec := do(t, srv, http.MethodPost, "/users/"+testUserID+"/credentials/"+anthropicID+"/lifeboat", nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("designate active as lifeboat: got %d, want 409", rec.Code)
	}

	// Designate local -> 200, is_lifeboat true.
	rec = do(t, srv, http.MethodPost, "/users/"+testUserID+"/credentials/"+local.ID+"/lifeboat", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("designate local: %d body=%s", rec.Code, rec.Body.String())
	}
	var got credential
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if !got.IsLifeboat {
		t.Fatal("designated credential is not is_lifeboat")
	}

	// Designate openrouter -> local's flag must clear (one lifeboat per user).
	rec = do(t, srv, http.MethodPost, "/users/"+testUserID+"/credentials/"+openrouter.ID+"/lifeboat", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("designate openrouter: %d body=%s", rec.Code, rec.Body.String())
	}
	_ = json.Unmarshal(do(t, srv, http.MethodGet, "/users/"+testUserID+"/credentials", nil).Body.Bytes(), &listed)
	lifeboats := 0
	for _, c := range listed.Credentials {
		if c.IsLifeboat {
			lifeboats++
			if c.ID != openrouter.ID {
				t.Fatalf("wrong lifeboat: %s", c.ID)
			}
		}
	}
	if lifeboats != 1 {
		t.Fatalf("expected exactly 1 lifeboat, got %d", lifeboats)
	}

	// Clear it -> 200, none flagged.
	rec = do(t, srv, http.MethodDelete, "/users/"+testUserID+"/credentials/"+openrouter.ID+"/lifeboat", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("clear lifeboat: %d", rec.Code)
	}
	_ = json.Unmarshal(do(t, srv, http.MethodGet, "/users/"+testUserID+"/credentials", nil).Body.Bytes(), &listed)
	for _, c := range listed.Credentials {
		if c.IsLifeboat {
			t.Fatalf("lifeboat still set after clear: %s", c.ID)
		}
	}
}

func strptr(s string) *string { return &s }

// --- /internal/* rejects requests without the shared secret ----------------
func TestInternalRequiresToken(t *testing.T) {
	srv := newTestServer(t)
	// Bypass do()'s auto-header by building the request directly.
	req := httptest.NewRequest(http.MethodGet,
		"/internal/users/"+testUserID+"/credential/active", nil)
	rec := httptest.NewRecorder()
	srv.routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("internal without token: got %d, want 401", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "api_key") {
		t.Fatalf("unauthorized response should not include credential data")
	}
}

// --- per-user assistant name -----------------------------------------------

func TestGetAssistantNameDefault(t *testing.T) {
	srv := newTestServer(t)
	// Reset to the column default so this test is order-independent.
	if _, err := testPool.Exec(context.Background(),
		`UPDATE users SET assistant_name = DEFAULT WHERE id = $1`, testUserID); err != nil {
		t.Fatalf("reset: %v", err)
	}
	rec := do(t, srv, http.MethodGet, "/users/"+testUserID+"/profile", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("get profile: got %d body=%s", rec.Code, rec.Body.String())
	}
	var got map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if got["assistant_name"] != "Raphael" {
		t.Fatalf("default assistant_name = %q, want Raphael", got["assistant_name"])
	}
}

func TestPutAssistantNameUpdatesAndGetReflects(t *testing.T) {
	srv := newTestServer(t)
	rec := do(t, srv, http.MethodPut, "/users/"+testUserID+"/profile",
		map[string]string{"assistant_name": "  Jarvis  "})
	if rec.Code != http.StatusOK {
		t.Fatalf("put: got %d body=%s", rec.Code, rec.Body.String())
	}
	var put map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &put)
	if put["assistant_name"] != "Jarvis" {
		t.Fatalf("put returned %q, want trimmed Jarvis", put["assistant_name"])
	}
	rec = do(t, srv, http.MethodGet, "/users/"+testUserID+"/profile", nil)
	var got map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if got["assistant_name"] != "Jarvis" {
		t.Fatalf("get after put = %q, want Jarvis", got["assistant_name"])
	}
}

func TestPutAssistantNameValidation(t *testing.T) {
	srv := newTestServer(t)
	for _, name := range []string{"", "     ", strings.Repeat("a", 41)} {
		rec := do(t, srv, http.MethodPut, "/users/"+testUserID+"/profile",
			map[string]string{"assistant_name": name})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("put %q: got %d, want 400 body=%s", name, rec.Code, rec.Body.String())
		}
	}
	// A 40-char name is the boundary and must succeed.
	rec := do(t, srv, http.MethodPut, "/users/"+testUserID+"/profile",
		map[string]string{"assistant_name": strings.Repeat("a", 40)})
	if rec.Code != http.StatusOK {
		t.Fatalf("put 40-char: got %d, want 200 body=%s", rec.Code, rec.Body.String())
	}
}

// GET /profile must carry the onboarded flag. Reset it to a known value so the
// test is order-independent.
func TestGetProfileIncludesOnboarded(t *testing.T) {
	srv := newTestServer(t)
	if _, err := testPool.Exec(context.Background(),
		`UPDATE users SET onboarded = false WHERE id = $1`, testUserID); err != nil {
		t.Fatalf("reset: %v", err)
	}
	rec := do(t, srv, http.MethodGet, "/users/"+testUserID+"/profile", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("get profile: got %d body=%s", rec.Code, rec.Body.String())
	}
	var got map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	v, ok := got["onboarded"]
	if !ok {
		t.Fatalf("get profile missing onboarded field: %s", rec.Body.String())
	}
	if v != false {
		t.Fatalf("onboarded = %v, want false", v)
	}
}

// PUT with onboarded:true persists it, and GET reflects it.
func TestPutOnboardedSetsAndGetReflects(t *testing.T) {
	srv := newTestServer(t)
	if _, err := testPool.Exec(context.Background(),
		`UPDATE users SET onboarded = false WHERE id = $1`, testUserID); err != nil {
		t.Fatalf("reset: %v", err)
	}
	rec := do(t, srv, http.MethodPut, "/users/"+testUserID+"/profile",
		map[string]any{"assistant_name": "Jarvis", "onboarded": true})
	if rec.Code != http.StatusOK {
		t.Fatalf("put: got %d body=%s", rec.Code, rec.Body.String())
	}
	var put map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &put)
	if put["onboarded"] != true {
		t.Fatalf("put returned onboarded=%v, want true", put["onboarded"])
	}
	rec = do(t, srv, http.MethodGet, "/users/"+testUserID+"/profile", nil)
	var got map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if got["onboarded"] != true {
		t.Fatalf("get after put onboarded=%v, want true", got["onboarded"])
	}
}

// The load-bearing one: a PUT with ONLY assistant_name (a Settings name edit)
// must NOT flip onboarded back to false.
func TestPutNameOnlyLeavesOnboardedUnchanged(t *testing.T) {
	srv := newTestServer(t)
	if _, err := testPool.Exec(context.Background(),
		`UPDATE users SET onboarded = true WHERE id = $1`, testUserID); err != nil {
		t.Fatalf("reset: %v", err)
	}
	rec := do(t, srv, http.MethodPut, "/users/"+testUserID+"/profile",
		map[string]string{"assistant_name": "Friday"})
	if rec.Code != http.StatusOK {
		t.Fatalf("put: got %d body=%s", rec.Code, rec.Body.String())
	}
	var put map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &put)
	if put["onboarded"] != true {
		t.Fatalf("name-only put returned onboarded=%v, want unchanged true", put["onboarded"])
	}
	rec = do(t, srv, http.MethodGet, "/users/"+testUserID+"/profile", nil)
	var got map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if got["onboarded"] != true {
		t.Fatalf("get after name-only put onboarded=%v, want true (must not reset)", got["onboarded"])
	}
}

func TestProfileNonUUIDIs404Not500(t *testing.T) {
	srv := newTestServer(t)
	rec := do(t, srv, http.MethodGet, "/users/not-a-uuid/profile", nil)
	if rec.Code == http.StatusInternalServerError {
		t.Fatalf("non-uuid uid 500ed (22P02 leaked): %s", rec.Body.String())
	}
	if rec.Code != http.StatusNotFound {
		t.Fatalf("non-uuid uid: got %d, want 404", rec.Code)
	}
	// Distinguish our clean JSON 404 from ServeMux's plain "404 page not found".
	if !strings.Contains(rec.Body.String(), "user not found") {
		t.Fatalf("expected clean JSON 404, got %s", rec.Body.String())
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

// --- Google: status/delete never leak a token, uuid guarded ----------------

// fakeIDToken builds a Google-shaped id_token JWT (header.payload.sig). Only the
// payload is read (unverified) so the header/signature are placeholders.
func fakeIDToken(email, sub string) string {
	payload, _ := json.Marshal(map[string]string{"email": email, "sub": sub})
	return "e30." + base64.RawURLEncoding.EncodeToString(payload) + ".sig"
}

// setGoogleConfig sets the OAuth env for a test and points the token endpoint at
// a fake, restoring the real URL on cleanup.
func setGoogleConfig(t *testing.T, fakeURL string) {
	t.Helper()
	t.Setenv("GOOGLE_CLIENT_ID", "test-client-id")
	t.Setenv("GOOGLE_CLIENT_SECRET", "test-client-secret")
	t.Setenv("GOOGLE_REDIRECT_URI", "https://app.raphael.local/google/callback")
	old := googleTokenURL
	googleTokenURL = fakeURL
	t.Cleanup(func() { googleTokenURL = old })
}

func TestGoogleStatusNotConnectedNoToken(t *testing.T) {
	srv := newTestServer(t)
	rec := do(t, srv, http.MethodGet, "/users/"+testUserID+"/google/status", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d body=%s", rec.Code, rec.Body.String())
	}
	var st map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &st)
	if st["connected"] != false {
		t.Fatalf("connected = %v, want false", st["connected"])
	}
	for _, k := range []string{"access_token", "refresh_token", "token"} {
		if _, ok := st[k]; ok {
			t.Fatalf("status leaked a %q field: %s", k, rec.Body.String())
		}
	}
}

func TestGoogleStatusConnectedNeverReturnsToken(t *testing.T) {
	srv := newTestServer(t)
	// Insert a row directly via the store with fake (encrypted) tokens.
	if err := srv.store.upsertGoogle(context.Background(), testUserID,
		"1//fake-refresh", "ya29.fake-access", time.Now().Add(time.Hour),
		[]string{"openid", "email", "https://www.googleapis.com/auth/calendar.readonly"},
		"person@example.com", "sub-abc"); err != nil {
		t.Fatalf("upsert: %v", err)
	}

	rec := do(t, srv, http.MethodGet, "/users/"+testUserID+"/google/status", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if strings.Contains(body, "fake-refresh") || strings.Contains(body, "fake-access") {
		t.Fatalf("status leaked a token: %s", body)
	}
	var st map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &st)
	if st["connected"] != true {
		t.Fatalf("connected = %v, want true", st["connected"])
	}
	if st["email"] != "person@example.com" {
		t.Fatalf("email = %v, want person@example.com", st["email"])
	}
	if _, ok := st["access_token"]; ok {
		t.Fatalf("status response has an access_token field: %s", body)
	}
	scopes, _ := st["scopes"].([]any)
	if len(scopes) != 3 {
		t.Fatalf("scopes = %v, want 3", st["scopes"])
	}
}

func TestGoogleDeleteIdempotent(t *testing.T) {
	srv := newTestServer(t)
	// Delete when absent is still 200 {connected:false}.
	rec := do(t, srv, http.MethodDelete, "/users/"+testUserID+"/google", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete absent: got %d body=%s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["connected"] != false {
		t.Fatalf("delete absent connected = %v, want false", out["connected"])
	}

	// Insert then delete removes it.
	if err := srv.store.upsertGoogle(context.Background(), testUserID,
		"1//r", "ya29.a", time.Now().Add(time.Hour), []string{"openid"}, "x@y.z", "s"); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	rec = do(t, srv, http.MethodDelete, "/users/"+testUserID+"/google", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete present: got %d", rec.Code)
	}
	rec = do(t, srv, http.MethodGet, "/users/"+testUserID+"/google/status", nil)
	var st map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &st)
	if st["connected"] != false {
		t.Fatalf("after delete connected = %v, want false", st["connected"])
	}
}

func TestGoogleNonUUIDIs404(t *testing.T) {
	srv := newTestServer(t)
	rec := do(t, srv, http.MethodGet, "/users/not-a-uuid/google/status", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status non-uuid: got %d, want 404", rec.Code)
	}
	rec = do(t, srv, http.MethodDelete, "/users/not-a-uuid/google", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("delete non-uuid: got %d, want 404", rec.Code)
	}
}

// --- Google: exchange via a fake token endpoint stores + status reflects ----

func TestGoogleExchangeStoresAndStatusReflects(t *testing.T) {
	srv := newTestServer(t)

	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.FormValue("grant_type") != "authorization_code" {
			t.Errorf("exchange grant_type = %q, want authorization_code", r.FormValue("grant_type"))
		}
		if r.FormValue("code") != "auth-code-xyz" {
			t.Errorf("exchange code = %q", r.FormValue("code"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token":  "ya29.EXCHANGED",
			"refresh_token": "1//REFRESH-TOKEN",
			"expires_in":    3600,
			"scope":         "openid email profile https://www.googleapis.com/auth/calendar.readonly",
			"id_token":      fakeIDToken("me@example.com", "sub-123"),
			"token_type":    "Bearer",
		})
	}))
	defer fake.Close()
	setGoogleConfig(t, fake.URL)

	rec := do(t, srv, http.MethodPost, "/internal/users/"+testUserID+"/google/exchange",
		map[string]string{"code": "auth-code-xyz"})
	if rec.Code != http.StatusOK {
		t.Fatalf("exchange: got %d body=%s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["email"] != "me@example.com" {
		t.Fatalf("exchange email = %v, want me@example.com", out["email"])
	}
	// The refresh token must never appear in the exchange response.
	if strings.Contains(rec.Body.String(), "REFRESH-TOKEN") {
		t.Fatalf("exchange response leaked the refresh token: %s", rec.Body.String())
	}

	// Public status now reflects the connection, still with no token.
	rec = do(t, srv, http.MethodGet, "/users/"+testUserID+"/google/status", nil)
	var st map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &st)
	if st["connected"] != true || st["email"] != "me@example.com" {
		t.Fatalf("status after exchange = %s", rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "EXCHANGED") || strings.Contains(rec.Body.String(), "REFRESH-TOKEN") {
		t.Fatalf("status leaked a token: %s", rec.Body.String())
	}

	// Internal token returns the cached (valid) access token without refreshing.
	rec = do(t, srv, http.MethodGet, "/internal/users/"+testUserID+"/google/token", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("token: got %d body=%s", rec.Code, rec.Body.String())
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["access_token"] != "ya29.EXCHANGED" {
		t.Fatalf("token access_token = %v, want ya29.EXCHANGED", out["access_token"])
	}
}

// --- Google: expired access token triggers a refresh call -------------------

func TestGoogleTokenRefreshesOnExpiry(t *testing.T) {
	srv := newTestServer(t)

	// Store a row whose access token is already expired.
	if err := srv.store.upsertGoogle(context.Background(), testUserID,
		"1//OLD-REFRESH", "ya29.OLD", time.Now().Add(-time.Hour),
		[]string{"openid", "https://www.googleapis.com/auth/calendar.readonly"},
		"me@example.com", "sub-1"); err != nil {
		t.Fatalf("upsert: %v", err)
	}

	hit := false
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
		_ = r.ParseForm()
		if r.FormValue("grant_type") != "refresh_token" {
			t.Errorf("refresh grant_type = %q, want refresh_token", r.FormValue("grant_type"))
		}
		if r.FormValue("refresh_token") != "1//OLD-REFRESH" {
			t.Errorf("refresh sent refresh_token %q", r.FormValue("refresh_token"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": "ya29.REFRESHED",
			"expires_in":   3600,
			"token_type":   "Bearer",
		})
	}))
	defer fake.Close()
	setGoogleConfig(t, fake.URL)

	rec := do(t, srv, http.MethodGet, "/internal/users/"+testUserID+"/google/token", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("token: got %d body=%s", rec.Code, rec.Body.String())
	}
	if !hit {
		t.Fatal("expired token did not trigger a refresh call")
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["access_token"] != "ya29.REFRESHED" {
		t.Fatalf("token access_token = %v, want ya29.REFRESHED", out["access_token"])
	}
}

// --- Google: invalid_grant on refresh deletes the connection ----------------

func TestGoogleRefreshInvalidGrantDeletes(t *testing.T) {
	srv := newTestServer(t)
	if err := srv.store.upsertGoogle(context.Background(), testUserID,
		"1//REVOKED", "ya29.OLD", time.Now().Add(-time.Hour),
		[]string{"openid"}, "me@example.com", "sub-1"); err != nil {
		t.Fatalf("upsert: %v", err)
	}

	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error":             "invalid_grant",
			"error_description": "Token has been expired or revoked.",
		})
	}))
	defer fake.Close()
	setGoogleConfig(t, fake.URL)

	rec := do(t, srv, http.MethodGet, "/internal/users/"+testUserID+"/google/token", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("revoked refresh: got %d, want 404 body=%s", rec.Code, rec.Body.String())
	}
	// The dead connection must be gone.
	rec = do(t, srv, http.MethodGet, "/users/"+testUserID+"/google/status", nil)
	var st map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &st)
	if st["connected"] != false {
		t.Fatalf("after invalid_grant connected = %v, want false", st["connected"])
	}
}

// --- Google internal endpoints require the shared secret --------------------

func TestGoogleInternalRequiresToken(t *testing.T) {
	srv := newTestServer(t)
	for _, tc := range []struct {
		method, path string
	}{
		{http.MethodGet, "/internal/users/" + testUserID + "/google/token"},
		{http.MethodPost, "/internal/users/" + testUserID + "/google/exchange"},
	} {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		rec := httptest.NewRecorder()
		srv.routes().ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s without token: got %d, want 401", tc.method, tc.path, rec.Code)
		}
	}
}

// --- tasks -----------------------------------------------------------------

// newTestServer already clears this user's tasks, so each test starts empty.

func createTaskT(t *testing.T, srv *server, body createTaskReq) task {
	t.Helper()
	rec := do(t, srv, http.MethodPost, "/users/"+testUserID+"/tasks", body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create task: got %d body=%s", rec.Code, rec.Body.String())
	}
	var out task
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode task: %v", err)
	}
	return out
}

// A created task round-trips through GET; the list is in manual board order
// (position ASC). Create seeds a non-zero position (epoch now), so new cards
// land in creation order; a PATCH position moves a card without renumbering.
func TestTaskCreateListAndOrdering(t *testing.T) {
	srv := newTestServer(t)

	first := createTaskT(t, srv, createTaskReq{Title: "shipped", DueDate: "2020-01-01"})
	second := createTaskT(t, srv, createTaskReq{Title: "someday", Notes: "no due date"})
	third := createTaskT(t, srv, createTaskReq{Title: "urgent", DueDate: "2026-01-01"})

	// Create seeds a non-zero position from epoch(now).
	if first.Position == 0 {
		t.Fatalf("created task position = 0, want non-zero seed")
	}

	// Default order is position ASC = creation order.
	rec := do(t, srv, http.MethodGet, "/users/"+testUserID+"/tasks", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("list: got %d body=%s", rec.Code, rec.Body.String())
	}
	var got []task
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	wantOrder := []string{first.ID, second.ID, third.ID}
	if len(got) != len(wantOrder) {
		t.Fatalf("list len = %d, want %d: %s", len(got), len(wantOrder), rec.Body.String())
	}
	for i, id := range wantOrder {
		if got[i].ID != id {
			t.Fatalf("order[%d] = %s (%q), want %s", i, got[i].ID, got[i].Title, id)
		}
	}
	// The round-tripped fields survive.
	if got[0].Title != "shipped" || got[0].DueDate == nil || *got[0].DueDate != "2020-01-01" {
		t.Fatalf("field round-trip failed: %+v", got[0])
	}
	if got[1].DueDate != nil {
		t.Fatalf("no-due task should have null due_date, got %v", *got[1].DueDate)
	}

	// Fractional-index move: put "urgent" between the first two (only that row
	// changes). List must reflect the new manual order.
	mid := (first.Position + second.Position) / 2
	rec = do(t, srv, http.MethodPatch, "/users/"+testUserID+"/tasks/"+third.ID,
		map[string]float64{"position": mid})
	if rec.Code != http.StatusOK {
		t.Fatalf("patch position: got %d body=%s", rec.Code, rec.Body.String())
	}
	rec = do(t, srv, http.MethodGet, "/users/"+testUserID+"/tasks", nil)
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	wantOrder = []string{first.ID, third.ID, second.ID}
	for i, id := range wantOrder {
		if got[i].ID != id {
			t.Fatalf("after move order[%d] = %q, want %s", i, got[i].Title, id)
		}
	}
}

// Priority defaults to 'none', accepts a value on create, persists via PATCH,
// and rejects an invalid value with a clean 400 (never a CHECK-violation 500).
func TestTaskPriority(t *testing.T) {
	srv := newTestServer(t)

	// Default on create is 'none'.
	def := createTaskT(t, srv, createTaskReq{Title: "no priority given"})
	if def.Priority != "none" {
		t.Fatalf("default priority = %q, want none", def.Priority)
	}

	// Accepted on create.
	hi := createTaskT(t, srv, createTaskReq{Title: "important", Priority: "high"})
	if hi.Priority != "high" {
		t.Fatalf("create priority = %q, want high", hi.Priority)
	}

	// PATCH priority persists.
	rec := do(t, srv, http.MethodPatch, "/users/"+testUserID+"/tasks/"+def.ID,
		map[string]string{"priority": "high"})
	if rec.Code != http.StatusOK {
		t.Fatalf("patch priority: got %d body=%s", rec.Code, rec.Body.String())
	}
	var updated task
	_ = json.Unmarshal(rec.Body.Bytes(), &updated)
	if updated.Priority != "high" {
		t.Fatalf("priority after patch = %q, want high", updated.Priority)
	}

	// Invalid priority -> 400, on both create and PATCH.
	rec = do(t, srv, http.MethodPost, "/users/"+testUserID+"/tasks",
		createTaskReq{Title: "bad", Priority: "urgent"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("create bad priority: got %d, want 400 body=%s", rec.Code, rec.Body.String())
	}
	rec = do(t, srv, http.MethodPatch, "/users/"+testUserID+"/tasks/"+def.ID,
		map[string]string{"priority": "urgent"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("patch bad priority: got %d, want 400 body=%s", rec.Code, rec.Body.String())
	}
}

// Blank and over-length titles are rejected in Go with a clean 400 (never a
// CHECK-violation 500); notes defaults to "".
func TestTaskTitleValidation(t *testing.T) {
	srv := newTestServer(t)
	for _, title := range []string{"", "   ", strings.Repeat("a", 201)} {
		rec := do(t, srv, http.MethodPost, "/users/"+testUserID+"/tasks",
			createTaskReq{Title: title})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("create title %q: got %d, want 400 body=%s", title, rec.Code, rec.Body.String())
		}
	}
	// The 200-char boundary succeeds, and notes defaults to "".
	tk := createTaskT(t, srv, createTaskReq{Title: strings.Repeat("a", 200)})
	if tk.Notes != "" {
		t.Fatalf("notes default = %q, want empty", tk.Notes)
	}
	// A bad status on PATCH is a 400.
	rec := do(t, srv, http.MethodPatch, "/users/"+testUserID+"/tasks/"+tk.ID,
		map[string]string{"status": "archived"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("patch bad status: got %d, want 400 body=%s", rec.Code, rec.Body.String())
	}
}

// PATCH status open->done bumps updated_at, and it is uid-scoped: patching a
// task under another user's uid is a 404, leaving the real task untouched.
func TestTaskPatchStatusAndScoping(t *testing.T) {
	srv := newTestServer(t)
	tk := createTaskT(t, srv, createTaskReq{Title: "do the thing"})
	if tk.Status != "open" {
		t.Fatalf("new task status = %q, want open", tk.Status)
	}

	// The Kanban middle column: in_progress is now accepted (was a 400 pre-widen).
	rec0 := do(t, srv, http.MethodPatch, "/users/"+testUserID+"/tasks/"+tk.ID,
		map[string]string{"status": "in_progress"})
	if rec0.Code != http.StatusOK {
		t.Fatalf("patch in_progress: got %d, want 200 body=%s", rec0.Code, rec0.Body.String())
	}
	var mid task
	_ = json.Unmarshal(rec0.Body.Bytes(), &mid)
	if mid.Status != "in_progress" {
		t.Fatalf("status after in_progress patch = %q, want in_progress", mid.Status)
	}

	// Another user's uid must not reach this task -> 404.
	otherUID := "00000000-0000-0000-0000-0000000000aa"
	rec := do(t, srv, http.MethodPatch, "/users/"+otherUID+"/tasks/"+tk.ID,
		map[string]string{"status": "done"})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("cross-user patch: got %d, want 404 body=%s", rec.Code, rec.Body.String())
	}

	rec = do(t, srv, http.MethodPatch, "/users/"+testUserID+"/tasks/"+tk.ID,
		map[string]string{"status": "done"})
	if rec.Code != http.StatusOK {
		t.Fatalf("patch done: got %d body=%s", rec.Code, rec.Body.String())
	}
	var updated task
	_ = json.Unmarshal(rec.Body.Bytes(), &updated)
	if updated.Status != "done" {
		t.Fatalf("status after patch = %q, want done", updated.Status)
	}
	if !updated.UpdatedAt.After(tk.UpdatedAt) {
		t.Fatalf("updated_at not bumped: was %s, now %s", tk.UpdatedAt, updated.UpdatedAt)
	}
}

// due_date: a PATCH with due_date:null clears it, while an omitted due_date
// leaves the stored value untouched.
func TestTaskPatchDueDateClearVsAbsent(t *testing.T) {
	srv := newTestServer(t)
	tk := createTaskT(t, srv, createTaskReq{Title: "with a due date", DueDate: "2026-06-06"})

	// Omitting due_date (patching only title) must leave the date in place.
	rec := do(t, srv, http.MethodPatch, "/users/"+testUserID+"/tasks/"+tk.ID,
		map[string]string{"title": "renamed"})
	var afterName task
	_ = json.Unmarshal(rec.Body.Bytes(), &afterName)
	if afterName.DueDate == nil || *afterName.DueDate != "2026-06-06" {
		t.Fatalf("absent due_date changed the date: %v", afterName.DueDate)
	}

	// Present-but-null clears it.
	rec = do(t, srv, http.MethodPatch, "/users/"+testUserID+"/tasks/"+tk.ID,
		map[string]any{"due_date": nil})
	if rec.Code != http.StatusOK {
		t.Fatalf("clear due_date: got %d body=%s", rec.Code, rec.Body.String())
	}
	var cleared task
	_ = json.Unmarshal(rec.Body.Bytes(), &cleared)
	if cleared.DueDate != nil {
		t.Fatalf("due_date not cleared: %v", *cleared.DueDate)
	}
}

// DELETE removes an owned task (200 deleted:true); a not-owned task is 404.
func TestTaskDeleteOwnedAndNotOwned(t *testing.T) {
	srv := newTestServer(t)
	tk := createTaskT(t, srv, createTaskReq{Title: "delete me"})

	otherUID := "00000000-0000-0000-0000-0000000000bb"
	rec := do(t, srv, http.MethodDelete, "/users/"+otherUID+"/tasks/"+tk.ID, nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("delete not-owned: got %d, want 404 body=%s", rec.Code, rec.Body.String())
	}

	rec = do(t, srv, http.MethodDelete, "/users/"+testUserID+"/tasks/"+tk.ID, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete owned: got %d body=%s", rec.Code, rec.Body.String())
	}
	var out map[string]bool
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if !out["deleted"] {
		t.Fatalf("delete response = %s, want deleted:true", rec.Body.String())
	}
	// Second delete is now a 404.
	rec = do(t, srv, http.MethodDelete, "/users/"+testUserID+"/tasks/"+tk.ID, nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("delete again: got %d, want 404", rec.Code)
	}
}

// A non-uuid task id must be a clean 404, never a 22P02 -> 500.
func TestTaskNonUUIDIdIs404(t *testing.T) {
	srv := newTestServer(t)
	rec := do(t, srv, http.MethodPatch, "/users/"+testUserID+"/tasks/not-a-uuid",
		map[string]string{"status": "done"})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("patch non-uuid id: got %d, want 404 body=%s", rec.Code, rec.Body.String())
	}
	rec = do(t, srv, http.MethodDelete, "/users/"+testUserID+"/tasks/not-a-uuid", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("delete non-uuid id: got %d, want 404 body=%s", rec.Code, rec.Body.String())
	}
}
