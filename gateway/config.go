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
	// InternalToken gates the trusted internal chat-ingress route (the WhatsApp
	// bridge), which takes user_id from the body instead of a JWT. Empty means
	// the route FAILS CLOSED — an unconfigured gateway never exposes open ingress.
	InternalToken   string
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
		// Defaults CLOSED. dev-login mints a 24h JWT for any email with no
		// password, so an unset var must never mean "enabled" — a deploy that
		// forgets it would be an account-takeover bypass. Both dev paths set it
		// explicitly (docker-compose.yml, scripts/dev.sh).
		DevAuthEnabled:  getenv("DEV_AUTH_ENABLED", "false") == "true",
		UserSvcURL:      getenv("USER_SVC_URL", "http://localhost:8081"),
		ConvSvcURL:      getenv("CONV_SVC_URL", "http://localhost:8082"),
		AgentSvcURL:     getenv("AGENT_SVC_URL", "http://localhost:8000"),
		InternalToken:   getenv("INTERNAL_TOKEN", ""),
		RateLimitPerMin: 60,
		CORSOrigins:     getenv("CORS_ORIGINS", "http://localhost:3000"),
	}
}
