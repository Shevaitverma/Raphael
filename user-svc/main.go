package main

import (
	"context"
	"log"
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
	dbURL := getenv("DATABASE_URL", "postgresql://raphael:raphael@localhost:5433/raphael")
	port := getenv("USER_SVC_PORT", "8081")

	// Fail loudly at boot if the encryption key is missing or malformed.
	crypto, err := newCryptor(os.Getenv("CREDENTIAL_ENC_KEY"))
	if err != nil {
		log.Fatalf("credential encryption unavailable: %v", err)
	}

	// Fail loudly if the internal shared secret is missing — /internal/* returns
	// decrypted keys and must never be left unauthenticated.
	internalToken := os.Getenv("INTERNAL_TOKEN")
	if internalToken == "" {
		log.Fatalf("INTERNAL_TOKEN is required (guards /internal/* credential endpoints)")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		log.Fatalf("connect postgres: %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		log.Fatalf("ping postgres: %v", err)
	}

	srv := &server{store: &store{pool: pool, crypto: crypto}, internalToken: internalToken}

	// LLM-free reminder scheduler: a background goroutine polls due reminders,
	// claims them (FOR UPDATE SKIP LOCKED) and writes notifications. Started once
	// after Ping so a dead DB fails at boot, not silently inside the ticker.
	startScheduler(pool)

	// LLM-free fitness coaching scheduler: sibling of startScheduler. Ticks every
	// 60s and writes templated check-in / weekly-summary / goal-nudge notifications.
	startFitnessCoach(pool)

	httpSrv := &http.Server{
		Addr:              ":" + port,
		Handler:           srv.routes(),
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Printf("user-svc listening on :%s", port)
	if err := httpSrv.ListenAndServe(); err != nil {
		log.Fatalf("server: %v", err)
	}
}
