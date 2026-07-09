package main

import "os"

// Config holds all runtime configuration, read once at boot from the
// environment. We never read .env directly; the process environment is the
// single source of truth (docker-compose / shell exports it).
type Config struct {
	Port           string
	DatabaseURL    string
	RedisURL       string
	JWTSecret      string
	DevAuthEnabled bool
	UserSvcURL     string
	ConvSvcURL     string
	AgentSvcURL    string
	RateLimitPerMin int
	// CORSOrigins is the comma-separated allow-list for the browser SPA. The web
	// app runs on a different origin than the gateway, so cross-origin requests
	// need explicit CORS or the browser blocks them (curl doesn't, which is why
	// it's easy to miss).
	CORSOrigins string
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func LoadConfig() Config {
	return Config{
		Port:            getenv("GATEWAY_PORT", "8080"),
		DatabaseURL:     getenv("DATABASE_URL", "postgresql://raphael:raphael@localhost:5433/raphael"),
		RedisURL:        getenv("REDIS_URL", "redis://localhost:6379/0"),
		JWTSecret:       getenv("JWT_SECRET", "dev-only-change-me"),
		DevAuthEnabled:  getenv("DEV_AUTH_ENABLED", "true") == "true",
		UserSvcURL:      getenv("USER_SVC_URL", "http://localhost:8081"),
		ConvSvcURL:      getenv("CONV_SVC_URL", "http://localhost:8082"),
		AgentSvcURL:     getenv("AGENT_SVC_URL", "http://localhost:8000"),
		RateLimitPerMin: 60,
		CORSOrigins:     getenv("CORS_ORIGINS", "http://localhost:3000"),
	}
}
