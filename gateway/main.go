package main

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

// Server holds the shared dependencies wired once at boot and used by every
// handler.
type Server struct {
	cfg   Config
	db    *pgxpool.Pool
	redis *redis.Client

	// httpClient is for buffered proxy + health calls (bounded timeouts).
	httpClient *http.Client
	// streamClient has NO overall timeout so SSE streams can stay open; it
	// relies on per-request context cancellation instead.
	streamClient *http.Client
}

func main() {
	cfg := LoadConfig()

	srv, err := NewServer(cfg)
	if err != nil {
		log.Fatalf("gateway: startup failed: %v", err)
	}

	app := srv.BuildApp()
	log.Printf("gateway: listening on :%s", cfg.Port)
	if err := app.Listen(":" + cfg.Port); err != nil {
		log.Fatalf("gateway: %v", err)
	}
}

// NewServer connects to Postgres and Redis and assembles the Server. The
// Postgres connection is required (dev-login needs it); Redis is created lazily
// and only reached at request time, so a momentarily-down cache never blocks
// boot.
func NewServer(cfg Config) (*Server, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		return nil, err
	}

	ropt, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		return nil, err
	}

	return &Server{
		cfg:   cfg,
		db:    pool,
		redis: redis.NewClient(ropt),
		httpClient: &http.Client{
			Timeout: 15 * time.Second,
		},
		streamClient: &http.Client{
			Timeout: 0, // no timeout: SSE streams are long-lived
		},
	}, nil
}

// BuildApp constructs the Fiber app and mounts every route. Split out from
// NewServer so tests can build the app against fake upstreams.
func (s *Server) BuildApp() *fiber.App {
	app := fiber.New(fiber.Config{
		AppName:               "raphael-gateway",
		DisableStartupMessage: true,
		// SSE streaming requires that responses are not pre-buffered.
		StreamRequestBody: true,
	})

	// CORS: the browser SPA is a different origin than the gateway, so without
	// this every /auth and /api call is blocked by the preflight. Allows the
	// configured web origin(s), the Authorization header, and the verbs we use.
	// AllowCredentials is on so the cross-origin SPA can send/receive the session
	// cookie the Google login sets — and credentials FORBID a wildcard origin, so
	// AllowOrigins must stay the explicit web origin(s) (CORSOrigins is exactly that).
	app.Use(cors.New(cors.Config{
		AllowOrigins:     s.cfg.CORSOrigins,
		AllowMethods:     "GET,POST,PUT,PATCH,DELETE,OPTIONS",
		AllowHeaders:     "Authorization,Content-Type,Accept",
		AllowCredentials: true,
	}))

	app.Get("/healthz", s.handleHealth) // liveness
	app.Get("/readyz", s.handleReady)   // readiness

	if s.cfg.DevAuthEnabled {
		app.Post("/auth/dev-login", s.handleDevLogin)
	}

	// Trusted internal chat-ingress (Phase 1 of the WhatsApp bridge). An inbound
	// WhatsApp message has no JWT, so this route takes user_id from the body and is
	// gated by requireInternal's shared secret. It is mounted at TOP LEVEL, OUTSIDE
	// the /api JWT group, deliberately — the secret is its only auth. It fails
	// closed when INTERNAL_TOKEN is unset.
	app.Post("/internal/chat", s.requireInternal, s.handleInternalChat)

	// Google OAuth callback. Google redirects a BROWSER here with no JWT, so it
	// is mounted at TOP LEVEL, OUTSIDE the /api group — exactly like /internal/chat.
	// The signed `state` query param carries + authenticates the user_id; the
	// handler verifies its HMAC before trusting it. No token ever rides the redirect.
	app.Get("/auth/google/callback", s.handleGoogleCallback)

	// Google Sign-In IS the login now. These two are PUBLIC (no JWT) and mounted
	// at TOP LEVEL alongside the callback:
	//   /auth/google/login → builds the consent URL and 302s the browser to Google
	//                        (no logged-in uid yet; the callback authenticates).
	//   /auth/session      → reads the session cookie and returns the current
	//                        user + role (or 401). Its own guard is the cookie, so
	//                        it must live outside the Bearer-JWT /api group.
	app.Get("/auth/google/login", s.handleGoogleLoginStart)
	app.Get("/auth/session", s.handleSession)
	// Real logout: revokes the durable session in Redis and clears the cookie. POST
	// (state-changing), public, gated by the caller's own session cookie.
	app.Post("/auth/logout", s.handleLogout)

	// Everything under /api requires a valid JWT and is rate limited.
	api := app.Group("/api", s.authMiddleware, s.rateLimitMiddleware)

	api.Post("/chat", s.handleChat)
	api.Get("/capabilities", s.proxyCapabilities)

	// Memory reads: uid forced from the JWT, proxied to agent-svc.
	api.Get("/memory/graph", s.proxyMemoryGraph)
	api.Get("/memory/stats", s.proxyMemoryStats)
	api.Get("/memory/portrait", s.proxyMemoryPortrait)

	// Conversations: exactly the three routes in the contract. Message *writes*
	// are agent-svc's job (it posts to conv-svc directly), so there is no
	// POST /conversations/:id/messages here — a client cannot write a message.
	api.Get("/conversations", s.proxyConversations)
	api.Post("/conversations", s.proxyConversations)
	api.Get("/conversations/:id/messages", s.proxyConversations)
	// Delete a conversation (cascades its messages in conv-svc). Reuses the same
	// uid-forcing proxy: user_id is Set from the JWT, ".." is rejected. Only DELETE
	// on this exact path is mounted — message writes stay agent-svc's job.
	api.Delete("/conversations/:id", s.proxyConversations)

	// Providers: exact and wildcard. The proxy roots every target at
	// /users/<uid>/credentials so user-svc /internal/* is unreachable.
	api.All("/providers", s.proxyProviders)
	api.All("/providers/*", s.proxyProviders)

	// Profile: assistant_name read/write. Rooted at /users/<uid>/profile so the
	// uid always comes from the JWT, never a client-supplied one.
	api.Get("/profile", s.proxyProfile)
	api.Put("/profile", s.proxyProfile)

	// Tasks: CRUD rooted at /users/<uid>/tasks so the uid always comes from the
	// JWT, never a client-supplied one. The :id (a task uuid) is path-escaped and
	// traversal-guarded in proxyTasks.
	api.Get("/tasks", s.proxyTasks)
	api.Post("/tasks", s.proxyTasks)
	api.Patch("/tasks/:id", s.proxyTasks)
	api.Delete("/tasks/:id", s.proxyTasks)

	// Reminders: same JWT-uid-forcing proxy as tasks. Two doors — this REST path
	// (0 tokens) and the chat create_reminder tool (NL compiled once). The :id is
	// traversal-guarded in proxyReminders.
	api.Get("/reminders", s.proxyReminders)
	api.Post("/reminders", s.proxyReminders)
	api.Patch("/reminders/:id", s.proxyReminders)
	api.Delete("/reminders/:id", s.proxyReminders)

	// Notifications: the in-app delivery feed. GET list + PATCH :id/read.
	api.Get("/notifications", s.proxyNotifications)
	api.Patch("/notifications/:id/read", s.proxyNotifications)

	// Timezone: web auto-detects + Settings picker PUTs the IANA tz.
	api.Put("/timezone", s.proxyTimezone)

	// Fitness: workouts + body metrics + stats, same JWT-uid-forcing proxy as
	// tasks/reminders. The :id and ?type= ride inside proxyFitness's guarded path.
	api.Get("/fitness/workouts", s.proxyFitness)
	api.Post("/fitness/workouts", s.proxyFitness)
	api.Delete("/fitness/workouts/:id", s.proxyFitness)
	api.Get("/fitness/metrics", s.proxyFitness)
	api.Post("/fitness/metrics", s.proxyFitness)
	api.Delete("/fitness/metrics/:id", s.proxyFitness)
	api.Get("/fitness/stats", s.proxyFitness)

	// Google: connect builds the consent URL (JWT-gated, returns JSON not a 302
	// so the JWT stays out of the browser URL); status/disconnect proxy to
	// user-svc rooted at the JWT uid. The callback is public and mounted above.
	api.Get("/google/connect", s.handleGoogleConnect)
	api.Get("/google/status", s.proxyGoogle)
	api.Delete("/google", s.proxyGoogle)

	// Admin surface: JWT (inherited from /api) PLUS a DB-verified admin role.
	// requireAdmin re-reads users.role from Postgres on every hit, so a member
	// cannot escalate with a stale/crafted JWT claim — fail closed. Every handler
	// lives in admin.go and proxies to user-svc /internal, the gateway forcing the
	// uid (never a client-supplied one). All admin config editing is pure REST → 0
	// LLM tokens.
	admin := api.Group("/admin", s.requireAdmin)

	// Allowlist = invites. Adding an email is what permits that person's first
	// Google sign-in; uninvited emails are rejected at the callback (fail closed).
	admin.Post("/allowlist", s.proxyAllowlist)       // add an email
	admin.Get("/allowlist", s.proxyAllowlist)        // list allowlisted emails
	admin.Delete("/allowlist/:email", s.proxyAllowlist) // remove one (handler reads :email)

	// User management: list, promote/demote (role), remove.
	admin.Get("/users", s.proxyAdminUsers)            // list users + roles
	admin.Patch("/users/:id/role", s.proxyAdminUsers) // change a user's role
	admin.Delete("/users/:id", s.proxyAdminUsers)     // remove a user

	// System provider/model config: admin-owned, system-wide. Proxies the EXISTING
	// /users/<uid>/credentials handlers rooted at SYSTEM_CONFIG_UID (not the JWT
	// uid) — same table, one-active index, lifeboat and portability semantics
	// unchanged. Members never see or configure providers.
	admin.All("/providers", s.proxySystemProviders)
	admin.All("/providers/*", s.proxySystemProviders)

	return app
}
