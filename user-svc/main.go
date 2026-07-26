package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	setupLogging()
	requireEnv("DATABASE_URL")

	dbURL := getenv("DATABASE_URL", "postgresql://raphael:raphael@localhost:5433/raphael")
	port := getenv("USER_SVC_PORT", "8081")

	// ONE line with the resolved critical config, so drift between services (a
	// stale GOOGLE_REDIRECT_URI here and a new one in the gateway) shows up at
	// boot instead of costing an afternoon. Secrets are SET/UNSET only, and
	// DATABASE_URL is never printed — it embeds the password.
	slog.Info("config",
		"port", port,
		"google_redirect_uri", os.Getenv("GOOGLE_REDIRECT_URI"),
		"database_url", secretState(dbURL),
		"credential_enc_key", secretState(os.Getenv("CREDENTIAL_ENC_KEY")),
		"internal_token", secretState(os.Getenv("INTERNAL_TOKEN")),
		"google_client_id", secretState(os.Getenv("GOOGLE_CLIENT_ID")),
		"google_client_secret", secretState(os.Getenv("GOOGLE_CLIENT_SECRET")),
	)

	// Fail loudly at boot if the encryption key is missing or malformed.
	crypto, err := newCryptor(os.Getenv("CREDENTIAL_ENC_KEY"))
	if err != nil {
		slog.Error("credential encryption unavailable", "err", err.Error())
		os.Exit(1)
	}

	// Fail loudly if the internal shared secret is missing — /internal/* returns
	// decrypted keys and must never be left unauthenticated.
	internalToken := os.Getenv("INTERNAL_TOKEN")
	if internalToken == "" {
		slog.Error("INTERNAL_TOKEN is required (guards /internal/* credential endpoints)")
		os.Exit(1)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		slog.Error("connect postgres", "err", err.Error())
		os.Exit(1)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		slog.Error("ping postgres", "err", err.Error())
		os.Exit(1)
	}

	srv := &server{store: &store{pool: pool, crypto: crypto}, internalToken: internalToken}

	// LLM-free reminder scheduler: a background goroutine polls due reminders,
	// claims them (FOR UPDATE SKIP LOCKED) and writes notifications. Started once
	// after Ping so a dead DB fails at boot, not silently inside the ticker.
	startScheduler(pool)

	// LLM-free fitness coaching scheduler: sibling of startScheduler. Ticks every
	// 60s and writes templated check-in / weekly-summary / goal-nudge notifications.
	startFitnessCoach(pool)

	// Bind LOOPBACK by default. This service's public /users/{uid}/... routes carry
	// NO authentication — the entire isolation model is "only the gateway can reach
	// them", and the gateway is what forces uid from the JWT. Binding every
	// interface made that premise false: an audit read this box's real user data
	// from the LAN with no credentials, just by supplying a uid.
	// Containers need 0.0.0.0 for bridge networking, so it is configurable — but
	// the DEFAULT is safe and exposure has to be opted into explicitly.
	bindHost := os.Getenv("BIND_HOST")
	if bindHost == "" {
		bindHost = "127.0.0.1"
	}
	httpSrv := &http.Server{
		Addr:              bindHost + ":" + port,
		Handler:           withLogging(srv.routes()),
		ReadHeaderTimeout: 5 * time.Second,
	}
	slog.Info("listening", "addr", bindHost+":"+port)
	if err := httpSrv.ListenAndServe(); err != nil {
		slog.Error("server stopped", "err", err.Error())
		os.Exit(1)
	}
}
