package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
)

func TestSanitizeRequestID(t *testing.T) {
	cases := map[string]string{
		"abc-123_x.y":  "abc-123_x.y",
		"":             "",
		"has space":    "", // rejected, a fresh id is minted instead
		"line\nbreak":  "",
		`quote"; drop`: "",
		"0123456789012345678901234567890123456789012345678901234567890123456789": "0123456789012345678901234567890123456789012345678901234567890123", // bounded to 64
	}
	for in, want := range cases {
		if got := sanitizeRequestID(in); got != want {
			t.Errorf("sanitizeRequestID(%q) = %q, want %q", in, got, want)
		}
	}
}

// The whole point of the correlation id: whatever the gateway assigns to an
// inbound request is the SAME id every downstream service sees.
func TestRequestIDReachesUpstream(t *testing.T) {
	var gotUpstream string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUpstream = r.Header.Get(requestIDHeader)
		w.Write([]byte(`{}`))
	}))
	defer upstream.Close()

	s := &Server{cfg: Config{UserSvcURL: upstream.URL}, httpClient: upstream.Client()}
	app := fiber.New()
	app.Use(s.requestLogger)
	app.Get("/p", func(c *fiber.Ctx) error {
		return s.forward(c, http.MethodGet, s.cfg.UserSvcURL+"/x", nil)
	})

	// 1. A sane inbound id is adopted end to end.
	req := httptest.NewRequest(http.MethodGet, "/p", nil)
	req.Header.Set(requestIDHeader, "trace-me-1")
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	if gotUpstream != "trace-me-1" {
		t.Errorf("upstream saw %q, want the inbound id", gotUpstream)
	}
	if got := resp.Header.Get(requestIDHeader); got != "trace-me-1" {
		t.Errorf("client saw %q, want the inbound id", got)
	}

	// 2. A junk inbound id is replaced, not forwarded — and one is still assigned.
	req = httptest.NewRequest(http.MethodGet, "/p", nil)
	req.Header.Set(requestIDHeader, "evil\nid")
	if _, err := app.Test(req); err != nil {
		t.Fatal(err)
	}
	if gotUpstream == "evil\nid" || gotUpstream == "" {
		t.Errorf("upstream saw %q, want a freshly minted id", gotUpstream)
	}
}
