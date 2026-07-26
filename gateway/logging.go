package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
)

// serviceName tags every log line so the four services can be grepped and
// aggregated together. Field names are identical across gateway/user-svc/
// conv-svc/agent-svc: time, level, msg, service, request_id, user_id, method,
// path, status, duration_ms, err.
const serviceName = "gateway"

// requestIDHeader carries the correlation id between services. Inbound values
// are trusted for CORRELATION ONLY — never for auth, never for authorization.
const requestIDHeader = "X-Request-Id"

// requestIDKey is the Fiber Locals key holding this request's correlation id.
const requestIDKey = "request_id"

// setupLogging installs a JSON slog logger as the process default. LOG_LEVEL
// (debug|info|warn|error) sets the threshold; anything else means info.
func setupLogging() {
	var lvl slog.Level
	switch strings.ToLower(os.Getenv("LOG_LEVEL")) {
	case "debug":
		lvl = slog.LevelDebug
	case "warn", "warning":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}
	h := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: lvl})
	slog.SetDefault(slog.New(h).With("service", serviceName))
}

// newRequestID returns a short random hex id. crypto/rand so ids don't collide
// across processes; the timestamp fallback keeps a request loggable even if the
// entropy source hiccups.
func newRequestID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return hex.EncodeToString(b[:])
}

// sanitizeRequestID bounds an inbound X-Request-Id: at most 64 chars from a
// conservative alphabet. A caller-supplied id lands in log files and downstream
// headers, so it never carries control characters or unbounded length.
func sanitizeRequestID(s string) string {
	if len(s) > 64 {
		s = s[:64]
	}
	for _, r := range s {
		ok := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.'
		if !ok {
			return ""
		}
	}
	return s
}

// reqID returns the correlation id assigned to this request, "" before the
// middleware has run (e.g. a handler invoked directly in a test).
func reqID(c *fiber.Ctx) string {
	id, _ := c.Locals(requestIDKey).(string)
	return id
}

// setReqID stamps the inbound request's correlation id onto an OUTBOUND
// request. Every gateway → user-svc/conv-svc/agent-svc call goes through one of
// the handful of builders that call this, so one turn is traceable end to end.
func setReqID(c *fiber.Ctx, req *http.Request) {
	if id := reqID(c); id != "" {
		req.Header.Set(requestIDHeader, id)
	}
}

// requestLogger assigns/propagates the correlation id and emits ONE access line
// per request. Mounted first so every route (and the CORS preflight) is covered.
func (s *Server) requestLogger(c *fiber.Ctx) error {
	id := sanitizeRequestID(c.Get(requestIDHeader))
	if id == "" {
		id = newRequestID()
	}
	c.Locals(requestIDKey, id)
	c.Set(requestIDHeader, id) // let the caller correlate too

	start := time.Now()
	err := c.Next()

	// Fiber's error handler runs AFTER middleware unwinds, so on error the
	// response status isn't written yet — derive it from the error instead.
	status := c.Response().StatusCode()
	if err != nil {
		status = fiber.StatusInternalServerError
		var fe *fiber.Error
		if errors.As(err, &fe) {
			status = fe.Code
		}
	}

	// Health probes poll constantly; keep them out of the info stream.
	lvl := slog.LevelInfo
	switch c.Path() {
	case "/health", "/healthz", "/readyz":
		lvl = slog.LevelDebug
	}

	attrs := []any{
		"request_id", id,
		"method", c.Method(),
		"path", c.Path(),
		"status", status,
		"duration_ms", durMS(start),
	}
	if uid, ok := c.Locals(userIDKey).(string); ok && uid != "" {
		attrs = append(attrs, "user_id", uid)
	}
	if err != nil {
		attrs = append(attrs, "err", err.Error())
	}
	slog.Log(c.Context(), lvl, "request", attrs...)
	return err
}

func durMS(start time.Time) float64 {
	return float64(time.Since(start).Microseconds()) / 1000
}

// secretState reports whether a secret is configured WITHOUT ever logging it.
func secretState(v string) string {
	if v == "" {
		return "UNSET"
	}
	return "SET"
}

// requireEnv exits non-zero when a required variable is missing, so a
// misconfigured deploy dies at boot instead of failing mysteriously later.
func requireEnv(keys ...string) {
	var missing []string
	for _, k := range keys {
		if os.Getenv(k) == "" {
			missing = append(missing, k)
		}
	}
	if len(missing) > 0 {
		slog.Error("missing required configuration", "vars", strings.Join(missing, ","))
		os.Exit(1)
	}
}
