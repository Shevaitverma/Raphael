package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	setupLogging()
	requireEnv("DATABASE_URL")

	dsn := getenv("DATABASE_URL", "postgresql://raphael:raphael@localhost:5433/raphael")
	port := getenv("CONV_SVC_PORT", "8082")

	// ONE line with the resolved critical config at boot. DATABASE_URL is
	// reported SET/UNSET only — it embeds the password.
	slog.Info("config", "port", port, "database_url", secretState(dsn))

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		slog.Error("connect postgres", "err", err.Error())
		os.Exit(1)
	}
	defer pool.Close()

	if err := pool.Ping(ctx); err != nil {
		slog.Error("ping postgres", "err", err.Error())
		os.Exit(1)
	}

	srv := newServer(pool, pool.Ping)
	handler := withLogging(srv.routes())

	// Bind LOOPBACK by default — see the same note in user-svc/main.go. conv-svc has
	// NO auth middleware at all: queryUserID IS the identity, so reaching this port
	// directly means reading or deleting anyone's conversations and messages by
	// supplying their uid. Containers set BIND_HOST=0.0.0.0 for bridge networking;
	// the default is safe.
	bindHost := os.Getenv("BIND_HOST")
	if bindHost == "" {
		bindHost = "127.0.0.1"
	}
	addr := bindHost + ":" + port
	slog.Info("listening", "addr", addr)
	if err := http.ListenAndServe(addr, handler); err != nil {
		slog.Error("server stopped", "err", err.Error())
		os.Exit(1)
	}
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
