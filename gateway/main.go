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
	app.Use(cors.New(cors.Config{
		AllowOrigins: s.cfg.CORSOrigins,
		AllowMethods: "GET,POST,DELETE,OPTIONS",
		AllowHeaders: "Authorization,Content-Type,Accept",
	}))

	app.Get("/healthz", s.handleHealth) // liveness
	app.Get("/readyz", s.handleReady)   // readiness

	if s.cfg.DevAuthEnabled {
		app.Post("/auth/dev-login", s.handleDevLogin)
	}

	// Everything under /api requires a valid JWT and is rate limited.
	api := app.Group("/api", s.authMiddleware, s.rateLimitMiddleware)

	api.Post("/chat", s.handleChat)
	api.Get("/capabilities", s.proxyCapabilities)

	// Conversations: exactly the three routes in the contract. Message *writes*
	// are agent-svc's job (it posts to conv-svc directly), so there is no
	// POST /conversations/:id/messages here — a client cannot write a message.
	api.Get("/conversations", s.proxyConversations)
	api.Post("/conversations", s.proxyConversations)
	api.Get("/conversations/:id/messages", s.proxyConversations)

	// Providers: exact and wildcard. The proxy roots every target at
	// /users/<uid>/credentials so user-svc /internal/* is unreachable.
	api.All("/providers", s.proxyProviders)
	api.All("/providers/*", s.proxyProviders)

	return app
}
