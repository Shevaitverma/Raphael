package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
)

// adminTestApp builds a bare Fiber app mounting ONLY the admin handlers (no
// requireAdmin — that gate is a sibling's; here we test the forwarding/rooting
// logic directly) against a fake user-svc that records the last request.
func adminTestApp(t *testing.T, capture func(*http.Request)) *fiber.App {
	t.Helper()
	user := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capture(r)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(user.Close)

	cfg := testConfig(user.URL, user.URL, user.URL)
	cfg.SystemConfigUID = "00000000-0000-0000-0000-000000000002"
	s := newServerT(t, cfg)

	app := fiber.New()
	app.All("/api/admin/providers", s.proxySystemProviders)
	app.All("/api/admin/providers/*", s.proxySystemProviders)
	app.Get("/api/admin/allowlist", s.proxyAllowlist)
	app.Post("/api/admin/allowlist", s.proxyAllowlist)
	app.Delete("/api/admin/allowlist/:email", s.proxyAllowlist)
	app.Get("/api/admin/users", s.proxyAdminUsers)
	app.Patch("/api/admin/users/:id/role", s.proxyAdminUsers)
	app.Delete("/api/admin/users/:id", s.proxyAdminUsers)
	return app
}

func TestAdminProxyRootsAndSecret(t *testing.T) {
	const sysUID = "00000000-0000-0000-0000-000000000002"

	cases := []struct {
		name       string
		method     string
		path       string
		wantPath   string
		wantSecret bool // internal routes must carry X-Internal-Token; public creds must NOT
	}{
		// System provider config: rooted at SYSTEM_CONFIG_UID, public credential
		// routes (no secret) — the whole point is reusing the per-user credential API.
		{"providers list", http.MethodGet, "/api/admin/providers",
			"/users/" + sysUID + "/credentials", false},
		{"providers activate", http.MethodPost, "/api/admin/providers/abc/activate",
			"/users/" + sysUID + "/credentials/abc/activate", false},
		{"providers lifeboat delete", http.MethodDelete, "/api/admin/providers/abc/lifeboat",
			"/users/" + sysUID + "/credentials/abc/lifeboat", false},
		// Allowlist + users: internal routes, MUST carry the shared secret.
		{"allowlist list", http.MethodGet, "/api/admin/allowlist",
			"/internal/admin/allowlist", true},
		{"allowlist remove escapes email", http.MethodDelete, "/api/admin/allowlist/a%40b.com",
			"/internal/admin/allowlist/a@b.com", true},
		{"user role", http.MethodPatch, "/api/admin/users/u1/role",
			"/internal/admin/users/u1/role", true},
		{"user delete", http.MethodDelete, "/api/admin/users/u1",
			"/internal/admin/users/u1", true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var gotPath, gotSecret string
			app := adminTestApp(t, func(r *http.Request) {
				gotPath = r.URL.Path
				gotSecret = r.Header.Get("X-Internal-Token")
			})
			resp, err := app.Test(httptest.NewRequest(tc.method, tc.path, nil), 5000)
			if err != nil {
				t.Fatalf("request: %v", err)
			}
			if resp.StatusCode != 200 {
				b, _ := io.ReadAll(resp.Body)
				t.Fatalf("status %d: %s", resp.StatusCode, b)
			}
			if gotPath != tc.wantPath {
				t.Fatalf("target path = %q, want %q", gotPath, tc.wantPath)
			}
			if tc.wantSecret && gotSecret != "test-internal-secret" {
				t.Fatalf("internal route missing X-Internal-Token (got %q)", gotSecret)
			}
			if !tc.wantSecret && gotSecret != "" {
				t.Fatalf("public credential route leaked X-Internal-Token (%q)", gotSecret)
			}
		})
	}
}

// A path segment named "internal" (or a traversal) must be refused, never
// forwarded — the same guard proxyProviders carries.
func TestAdminProxyRejectsInternalPath(t *testing.T) {
	forwarded := false
	app := adminTestApp(t, func(r *http.Request) { forwarded = true })
	resp, err := app.Test(httptest.NewRequest(http.MethodGet, "/api/admin/providers/internal", nil), 5000)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if resp.StatusCode != fiber.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	if forwarded {
		t.Fatal("suspicious path was forwarded to user-svc")
	}
}
