package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	dsn := getenv("DATABASE_URL", "postgresql://raphael:raphael@localhost:5433/raphael")
	port := getenv("CONV_SVC_PORT", "8082")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatalf("conv-svc: connect: %v", err)
	}
	defer pool.Close()

	if err := pool.Ping(ctx); err != nil {
		log.Fatalf("conv-svc: ping: %v", err)
	}

	srv := newServer(pool, pool.Ping)
	handler := srv.routes()

	addr := ":" + port
	log.Printf("conv-svc: listening on %s", addr)
	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatalf("conv-svc: serve: %v", err)
	}
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
