package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// stubGoogleTokenServer returns a fake Google token endpoint that answers the
// authorization_code exchange with the given id_token payload. Reuses the same
// stubbing pattern as the exchange tests (setGoogleConfig points googleTokenURL
// at it). email/sub go into the id_token; refresh is always present so the
// no-refresh guard passes.
func stubGoogleTokenServer(t *testing.T, idEmail, idSub string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token":  "ya29.LOGIN",
			"refresh_token": "1//LOGIN-REFRESH",
			"expires_in":    3600,
			"scope":         "openid email profile https://www.googleapis.com/auth/calendar.readonly",
			"id_token":      fakeIDToken(idEmail, idSub),
			"token_type":    "Bearer",
		})
	}))
}

func postLogin(t *testing.T, srv *server, code string) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"code": code})
	req := httptest.NewRequest(http.MethodPost, "/internal/google/login", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	srv.googleLogin(rec, req) // call the handler directly; route wiring lives in handlers.go
	return rec
}

func googleRowCount(t *testing.T, pool *pgxpool.Pool, email string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM google_credentials WHERE google_email = $1`, email).Scan(&n); err != nil {
		t.Fatalf("count google rows: %v", err)
	}
	return n
}

// clearAuthVerifyUsers removes every throwaway auth-verify+*@raphael.test user
// (cascading their google_credentials via FK) and any matching allowlist rows, so
// a test starts from a known state. It touches ONLY throwaways — never DEV_UID or
// the system owner — satisfying the data-safety invariant.
func clearAuthVerifyUsers(t *testing.T) {
	t.Helper()
	_, _ = testPool.Exec(context.Background(),
		`DELETE FROM users WHERE email LIKE 'auth-verify+%@raphael.test'`)
	_, _ = testPool.Exec(context.Background(),
		`DELETE FROM allowed_emails WHERE email LIKE 'auth-verify+%@raphael.test'`)
}

// seedGoogleAdmin inserts a throwaway admin WITH a google_sub, which CLOSES the
// bootstrap window: resolveGoogleUser only auto-creates the first admin when no
// admin has ever signed in via Google (google_sub set). Tests that assert the
// post-bootstrap RBAC branches (allowlisted-member / uninvited-reject) call this
// so a brand-new email is NOT mistaken for the very first sign-in.
func seedGoogleAdmin(t *testing.T) {
	t.Helper()
	if _, err := testPool.Exec(context.Background(),
		`INSERT INTO users (email, name, role, google_sub)
		 VALUES ('auth-verify+seedadmin@raphael.test', 'seedadmin', 'admin', 'seed-admin-sub-fixed')
		 ON CONFLICT (email) DO UPDATE SET role = 'admin', google_sub = 'seed-admin-sub-fixed'`); err != nil {
		t.Fatalf("seed google admin: %v", err)
	}
}

// A. Case (1): the FIRST-ever Google sign-in (no admin has google-logged-in) must
// create the account as ADMIN and store its calendar-read credentials in the same
// step (one consent grants identity + calendar). This is the bootstrap branch.
func TestGoogleLoginBootstrapFirstUserBecomesAdmin(t *testing.T) {
	srv := newTestServer(t)
	clearAuthVerifyUsers(t) // no throwaway google_sub admin leaks in
	t.Cleanup(func() { clearAuthVerifyUsers(t) })

	// The bootstrap gate keys on "no admin has signed in via Google". On a DB where
	// a real human already google-logged-in that window is legitimately closed, so
	// skip rather than assert a bootstrap that cannot happen (and never touch that
	// real admin's row to force it).
	var n int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM users WHERE role = 'admin' AND google_sub IS NOT NULL`).Scan(&n); err != nil {
		t.Fatalf("count google admins: %v", err)
	}
	if n != 0 {
		t.Skipf("a Google-authenticated admin already exists (n=%d); bootstrap window closed", n)
	}

	const email = "auth-verify+bootstrap@raphael.test"
	fake := stubGoogleTokenServer(t, email, "sub-bootstrap")
	defer fake.Close()
	setGoogleConfig(t, fake.URL)

	rec := postLogin(t, srv, "code-bootstrap")
	if rec.Code != http.StatusOK {
		t.Fatalf("bootstrap login: got %d, want 200 body=%s", rec.Code, rec.Body.String())
	}
	var out map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["role"] != "admin" {
		t.Fatalf("bootstrap role = %q, want admin", out["role"])
	}
	if out["uid"] == "" {
		t.Fatal("bootstrap returned no uid")
	}
	// Case E: the SAME login stored calendar-read credentials for the new account.
	if got := googleRowCount(t, testPool, email); got != 1 {
		t.Fatalf("bootstrap stored %d google-cred rows, want 1 (calendar attaches on login)", got)
	}
}

// A. Case (2): an email an admin allowlisted signs in as MEMBER, and the invite is
// CONSUMED (single-use). Requires the bootstrap window closed (seedGoogleAdmin).
func TestGoogleLoginAllowlistedBecomesMemberAndConsumes(t *testing.T) {
	srv := newTestServer(t)
	clearAuthVerifyUsers(t)
	t.Cleanup(func() { clearAuthVerifyUsers(t) })
	seedGoogleAdmin(t)

	const email = "auth-verify+member@raphael.test"
	if err := srv.store.allowlistAdd(context.Background(), email); err != nil {
		t.Fatalf("allowlist add: %v", err)
	}

	fake := stubGoogleTokenServer(t, email, "sub-member")
	defer fake.Close()
	setGoogleConfig(t, fake.URL)

	rec := postLogin(t, srv, "code-member")
	if rec.Code != http.StatusOK {
		t.Fatalf("member login: got %d, want 200 body=%s", rec.Code, rec.Body.String())
	}
	var out map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["role"] != "member" {
		t.Fatalf("allowlisted role = %q, want member", out["role"])
	}
	var still int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM allowed_emails WHERE email = $1`, email).Scan(&still); err != nil {
		t.Fatalf("count allowlist: %v", err)
	}
	if still != 0 {
		t.Fatalf("invite not consumed: %d allowlist rows remain for %s", still, email)
	}
	if got := googleRowCount(t, testPool, email); got != 1 {
		t.Fatalf("member stored %d google-cred rows, want 1", got)
	}
}

// A. Case (4): an existing account (email already present, no google_sub — exactly
// how DEV_UID sits) is LOGGED INTO by email match, NOT duplicated, and its role is
// preserved. The verified sub is linked onto the existing row.
func TestGoogleLoginLinksExistingEmailNoDuplicate(t *testing.T) {
	srv := newTestServer(t)
	clearAuthVerifyUsers(t)
	t.Cleanup(func() { clearAuthVerifyUsers(t) })

	const email = "auth-verify+existing@raphael.test"
	var existingID string
	if err := testPool.QueryRow(context.Background(),
		`INSERT INTO users (email, name, role) VALUES ($1, 'existing', 'member') RETURNING id`,
		email).Scan(&existingID); err != nil {
		t.Fatalf("seed existing user: %v", err)
	}

	fake := stubGoogleTokenServer(t, email, "sub-existing-new")
	defer fake.Close()
	setGoogleConfig(t, fake.URL)

	rec := postLogin(t, srv, "code-existing")
	if rec.Code != http.StatusOK {
		t.Fatalf("link login: got %d, want 200 body=%s", rec.Code, rec.Body.String())
	}
	var out map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["uid"] != existingID {
		t.Fatalf("linked uid = %q, want SAME existing %q (account was duplicated)", out["uid"], existingID)
	}
	if out["role"] != "member" {
		t.Fatalf("linked role = %q, want member (existing role must be preserved)", out["role"])
	}
	var count int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM users WHERE email = $1`, email).Scan(&count); err != nil {
		t.Fatalf("count users: %v", err)
	}
	if count != 1 {
		t.Fatalf("email now on %d user rows, want 1 (a duplicate was created)", count)
	}
	var sub string
	_ = testPool.QueryRow(context.Background(),
		`SELECT coalesce(google_sub,'') FROM users WHERE id = $1`, existingID).Scan(&sub)
	if sub != "sub-existing-new" {
		t.Fatalf("linked google_sub = %q, want sub-existing-new", sub)
	}
}

// An id_token without an email cannot authenticate an identity. Must fail closed
// (400) BEFORE resolveGoogleUser / any credential write — this is pure handler
// logic, independent of the store's RBAC.
func TestGoogleLoginRejectsAnonymousIdentity(t *testing.T) {
	srv := newTestServer(t)
	fake := stubGoogleTokenServer(t, "", "sub-anon")
	defer fake.Close()
	setGoogleConfig(t, fake.URL)

	rec := postLogin(t, srv, "auth-code-anon")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("anon login: got %d, want 400 body=%s", rec.Code, rec.Body.String())
	}
	if got := googleRowCount(t, testPool, ""); got != 0 {
		t.Fatalf("anon login stored %d google rows, want 0 (fail closed)", got)
	}
}

// The last-admin guards (demote + remove) must count only LOGINABLE admins
// (role='admin' AND google_sub IS NOT NULL) — the same population bootstrap keys
// on. The two seeded sentinels (google_sub NULL) must NOT count, else the sole real
// admin could demote/remove themselves, dropping loginable-admins to 0 and silently
// re-arming bootstrap for the next uninvited stranger. Proves both guards trip when
// only one loginable admin exists, and release once a second one is added.
func TestLastAdminGuardsCountLoginableOnly(t *testing.T) {
	srv := newTestServer(t)
	clearAuthVerifyUsers(t)
	t.Cleanup(func() { clearAuthVerifyUsers(t) })

	// Only meaningful when no other loginable admin already exists (e.g. a real human
	// google-admin on this dev DB). Otherwise the guard legitimately won't trip.
	var baseline int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM users WHERE role='admin' AND google_sub IS NOT NULL`).Scan(&baseline); err != nil {
		t.Fatalf("count loginable admins: %v", err)
	}
	if baseline != 0 {
		t.Skipf("a loginable admin already exists (n=%d); last-admin window not isolatable", baseline)
	}

	// One throwaway loginable admin. Sentinels (DEV_UID, SYSTEM_CONFIG) also carry
	// role='admin' but google_sub NULL — they must be invisible to the guard.
	var adminID string
	if err := testPool.QueryRow(context.Background(),
		`INSERT INTO users (email, name, role, google_sub)
		 VALUES ('auth-verify+lastadmin@raphael.test', 'lastadmin', 'admin', 'sub-lastadmin') RETURNING id`).
		Scan(&adminID); err != nil {
		t.Fatalf("seed loginable admin: %v", err)
	}

	if err := srv.store.userSetRole(context.Background(), adminID, "member"); err != errLastAdmin {
		t.Fatalf("demote sole loginable admin: got %v, want errLastAdmin (sentinels must not count)", err)
	}
	if err := srv.store.userRemove(context.Background(), adminID); err != errLastAdmin {
		t.Fatalf("remove sole loginable admin: got %v, want errLastAdmin", err)
	}

	// Add a second loginable admin -> both operations release.
	var admin2 string
	if err := testPool.QueryRow(context.Background(),
		`INSERT INTO users (email, name, role, google_sub)
		 VALUES ('auth-verify+lastadmin2@raphael.test', 'lastadmin2', 'admin', 'sub-lastadmin2') RETURNING id`).
		Scan(&admin2); err != nil {
		t.Fatalf("seed second admin: %v", err)
	}
	if err := srv.store.userRemove(context.Background(), admin2); err != nil {
		t.Fatalf("remove one of two admins: got %v, want nil", err)
	}
	// adminID is once again the sole loginable admin -> guard trips again.
	if err := srv.store.userRemove(context.Background(), adminID); err != errLastAdmin {
		t.Fatalf("remove now-sole admin: got %v, want errLastAdmin", err)
	}
}

// An id_token whose email is NOT verified (email_verified=false) is attacker-
// controllable and must be REJECTED with 403 before it can match the allowlist or
// link onto an existing account — even when that email is allowlisted. Fail closed,
// store nothing.
func TestGoogleLoginRejectsUnverifiedEmail(t *testing.T) {
	srv := newTestServer(t)
	const email = "auth-verify+unverified@raphael.test"
	clearAuthVerifyUsers(t)
	t.Cleanup(func() { clearAuthVerifyUsers(t) })
	seedGoogleAdmin(t) // close bootstrap so the email would otherwise be allowlist-gated
	if err := srv.store.allowlistAdd(context.Background(), email); err != nil {
		t.Fatalf("allowlist add: %v", err)
	}

	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token":  "ya29.LOGIN",
			"refresh_token": "1//LOGIN-REFRESH",
			"expires_in":    3600,
			"scope":         "openid email profile https://www.googleapis.com/auth/calendar.readonly",
			"id_token":      fakeIDTokenClaims(map[string]any{"email": email, "sub": "sub-unverified", "email_verified": false}),
			"token_type":    "Bearer",
		})
	}))
	defer fake.Close()
	setGoogleConfig(t, fake.URL)

	rec := postLogin(t, srv, "code-unverified")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("unverified login: got %d, want 403 body=%s", rec.Code, rec.Body.String())
	}
	if got := googleRowCount(t, testPool, email); got != 0 {
		t.Fatalf("unverified login stored %d google rows, want 0 (fail closed)", got)
	}
	// The allowlisted invite must NOT be consumed by a rejected login.
	var still int
	_ = testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM allowed_emails WHERE email = $1`, email).Scan(&still)
	if still != 1 {
		t.Fatalf("unverified login consumed the invite: %d rows remain, want 1", still)
	}
}

// An uninvited email (not in allowed_emails, users table non-empty so not the
// bootstrap admin) must be REJECTED with 403 {"error":"not invited"} and store
// NOTHING — the core fail-closed security path.
func TestGoogleLoginRejectsUninvitedFailsClosed(t *testing.T) {
	srv := newTestServer(t)
	const email = "auth-verify+uninvited@raphael.test"
	// The reject branch only applies AFTER bootstrap: an admin must already have
	// signed in via Google, else this brand-new email would legitimately become the
	// bootstrap admin. seedGoogleAdmin closes that window; clearAuthVerifyUsers first
	// guarantees this throwaway is neither allowlisted nor pre-existing.
	clearAuthVerifyUsers(t)
	t.Cleanup(func() { clearAuthVerifyUsers(t) })
	seedGoogleAdmin(t)

	fake := stubGoogleTokenServer(t, email, "sub-uninvited")
	defer fake.Close()
	setGoogleConfig(t, fake.URL)

	rec := postLogin(t, srv, "auth-code-uninvited")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("uninvited login: got %d, want 403 body=%s", rec.Code, rec.Body.String())
	}
	var out map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["error"] != "not invited" {
		t.Fatalf("uninvited error = %q, want \"not invited\"", out["error"])
	}
	if got := googleRowCount(t, testPool, email); got != 0 {
		t.Fatalf("rejected login stored %d google rows, want 0 (fail closed)", got)
	}
}
