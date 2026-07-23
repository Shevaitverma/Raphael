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
	// Google OAuth. ClientID empty means the connect route returns 503 (fails
	// closed, never panics). RedirectURI is where Google sends the browser back —
	// it must match the /auth/google/callback route mounted OUTSIDE the JWT group.
	// WebOrigin is where the callback 302s the browser after exchange; no token
	// ever rides in that redirect.
	GoogleClientID     string
	GoogleClientSecret string
	GoogleRedirectURI  string
	WebOrigin          string
	// SystemConfigUID is the seeded "system config owner" user whose
	// provider_credentials rows ARE the system-wide model/provider config. Admin
	// provider proxies (admin.go) root at this uid instead of the JWT uid, and the
	// agent-svc resolver reads it for every user. Must match agent-svc's
	// SYSTEM_CONFIG_UID or the two languages would target divergent rows.
	SystemConfigUID string
	// SessionCookieName names the auth cookie; kept here so the login/callback and
	// logout paths agree on one value.
	SessionCookieName string
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func LoadConfig() Config {
	return Config{
		Port:        getenv("GATEWAY_PORT", "8080"),
		DatabaseURL: getenv("DATABASE_URL", "postgresql://raphael:raphael@localhost:5433/raphael"),
		RedisURL:    getenv("REDIS_URL", "redis://localhost:6379/0"),
		JWTSecret:   getenv("JWT_SECRET", "dev-only-change-me"),
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

		GoogleClientID:     getenv("GOOGLE_CLIENT_ID", ""),
		GoogleClientSecret: getenv("GOOGLE_CLIENT_SECRET", ""),
		GoogleRedirectURI:  getenv("GOOGLE_REDIRECT_URI", "http://localhost:8080/auth/google/callback"),
		WebOrigin:          getenv("WEB_ORIGIN", "http://localhost:3000"),

		// Fixed sentinel uuid for the system-config owner (see 001 migration seed).
		// Must equal agent-svc's SYSTEM_CONFIG_UID default.
		SystemConfigUID:   getenv("SYSTEM_CONFIG_UID", "00000000-0000-0000-0000-000000000002"),
		SessionCookieName: getenv("SESSION_COOKIE_NAME", "raphael_session"),
	}
}
