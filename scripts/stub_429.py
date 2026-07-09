"""Local stub that answers every OpenAI-compatible request with HTTP 429.

Used by scripts/e2e.sh to prove the lifeboat does NOT fire on a transient
rate-limit fault: agent-svc must emit an SSE 'error' event, never 'degraded',
and must not fall back to the local model. Retry-After: 0 keeps the openai
SDK's automatic retries fast. Listens on 127.0.0.1:9099 by default.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9099


class H(BaseHTTPRequestHandler):
    def _429(self):
        body = json.dumps({"error": {
            "message": "Rate limit exceeded (stub).",
            "type": "rate_limit_error",
            "code": "rate_limit_exceeded",
        }}).encode()
        self.send_response(429)
        self.send_header("Content-Type", "application/json")
        self.send_header("Retry-After", "0")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length:
            self.rfile.read(length)
        self._429()

    def do_GET(self):
        self._429()

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", PORT), H).serve_forever()
