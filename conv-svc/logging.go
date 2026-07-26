package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// serviceName tags every log line so the four services can be grepped and
// aggregated together. Field names are identical across gateway/user-svc/
// conv-svc/agent-svc: time, level, msg, service, request_id, user_id, method,
// path, status, duration_ms, err.
const serviceName = "conv-svc"

// requestIDHeader carries the correlation id the gateway stamps on every
// downstream call. Trusted for CORRELATION ONLY — never for auth and never for
// identity (the caller-scoped user_id is the gateway's JWT-forced one).
const requestIDHeader = "X-Request-Id"

type ctxKey int

const requestIDCtxKey ctxKey = iota

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

func newRequestID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return hex.EncodeToString(b[:])
}

// sanitizeRequestID bounds an inbound id: at most 64 chars from a conservative
// alphabet. It lands in log files, so it never carries control characters.
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

// requestID returns the correlation id carried by ctx, "" outside a request.
// Handlers use it so any log they emit joins the same trace:
//
//	slog.WarnContext(r.Context(), "…", "request_id", requestID(r.Context()))
func requestID(ctx context.Context) string {
	id, _ := ctx.Value(requestIDCtxKey).(string)
	return id
}

// statusRecorder captures the status code for the access log. An un-written
// header means net/http will send 200.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (w *statusRecorder) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

// withLogging adopts (or mints) the correlation id, puts it in the request
// context, and emits ONE access line per request.
func withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := sanitizeRequestID(r.Header.Get(requestIDHeader))
		if id == "" {
			id = newRequestID()
		}
		w.Header().Set(requestIDHeader, id)
		r = r.WithContext(context.WithValue(r.Context(), requestIDCtxKey, id))

		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		start := time.Now()
		next.ServeHTTP(rec, r)

		// Health probes poll constantly; keep them out of the info stream.
		lvl := slog.LevelInfo
		switch r.URL.Path {
		case "/health", "/healthz":
			lvl = slog.LevelDebug
		}

		attrs := []any{
			"request_id", id,
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"duration_ms", float64(time.Since(start).Microseconds()) / 1000,
		}
		// handlers.go's queryUserID is the one authority on reading ?user_id=
		// (it rejects a repeated param); a malformed one simply logs no user_id.
		if uid, err := queryUserID(r); err == nil {
			if len(uid) > 64 {
				uid = uid[:64] // bound an untrusted string before it hits a log file
			}
			attrs = append(attrs, "user_id", uid)
		}
		slog.Log(r.Context(), lvl, "request", attrs...)
	})
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
