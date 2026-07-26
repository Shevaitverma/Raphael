package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSanitizeRequestID(t *testing.T) {
	for in, want := range map[string]string{
		"abc-123_x.y": "abc-123_x.y",
		"":            "",
		"has space":   "", // rejected, a fresh id is minted instead
		"line\nbreak": "",
	} {
		if got := sanitizeRequestID(in); got != want {
			t.Errorf("sanitizeRequestID(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPathUserID(t *testing.T) {
	for path, want := range map[string]string{
		"/users/u1/fitness/goals":              "u1",
		"/internal/users/u2/credential/active": "u2",
		"/healthz":                             "",
		"/users":                               "",
	} {
		if got := pathUserID(path); got != want {
			t.Errorf("pathUserID(%q) = %q, want %q", path, got, want)
		}
	}
}

// The gateway's id must survive into this service's request context, so a log
// line written inside a handler joins the same trace.
func TestWithLoggingAdoptsRequestID(t *testing.T) {
	var seen string
	h := withLogging(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = requestID(r.Context())
		w.WriteHeader(http.StatusTeapot)
	}))

	req := httptest.NewRequest(http.MethodGet, "/users/u1/tasks", nil)
	req.Header.Set(requestIDHeader, "trace-me-1")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if seen != "trace-me-1" {
		t.Errorf("handler saw request id %q, want the inbound one", seen)
	}
	if got := rec.Header().Get(requestIDHeader); got != "trace-me-1" {
		t.Errorf("response echoed %q, want the inbound id", got)
	}

	// No inbound id: one is minted rather than left blank.
	seen = ""
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if seen == "" {
		t.Error("no request id assigned when the caller sent none")
	}
}
