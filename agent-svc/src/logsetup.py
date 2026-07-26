"""Structured JSON logging + request correlation for agent-svc.

Same field names as the three Go services (they use log/slog with a JSON
handler), so all four logs can be grepped and aggregated together:

    time, level, msg, service, request_id, user_id, method, path, status,
    duration_ms, err

Stdlib logging only — no python-json-logger, no structlog. Every module keeps
its plain ``logging.getLogger(__name__)``; records propagate to the root handler
installed here and come out as JSON with the current request's id attached.

NEVER logs a secret, a token, an OAuth code, a request body or a user message.
"""
from __future__ import annotations

import json
import logging
import os
import string
import sys
import time
import traceback
import uuid
from contextvars import ContextVar
from datetime import datetime, timezone
from urllib.parse import parse_qs

SERVICE = "agent-svc"

# The correlation id of the request being served. A ContextVar so every log line
# any module emits during the turn carries it without threading a parameter
# through the whole call graph.
request_id_var: ContextVar[str] = ContextVar("request_id", default="")

_LEVELS = {
    "debug": logging.DEBUG,
    "info": logging.INFO,
    "warn": logging.WARNING,
    "warning": logging.WARNING,
    "error": logging.ERROR,
}

# Extra fields a caller may attach via logging's ``extra=``; anything else on the
# record is ignored, so a stray attribute can never widen a log line.
_EXTRA_FIELDS = ("request_id", "user_id", "method", "path", "status", "duration_ms")

_ID_ALPHABET = frozenset(string.ascii_letters + string.digits + "-_.")


def new_request_id() -> str:
    return uuid.uuid4().hex[:16]


def sanitize_request_id(raw: str) -> str:
    """Bound an inbound X-Request-Id: <=64 chars from a conservative alphabet.

    Trusted for CORRELATION ONLY — never for auth, never for identity. It lands
    in a log file, so it never carries control characters or unbounded length.
    """
    raw = raw[:64]
    return raw if raw and all(c in _ID_ALPHABET for c in raw) else ""


class JsonFormatter(logging.Formatter):
    """One JSON object per line, with the Go services' field names."""

    def format(self, record: logging.LogRecord) -> str:  # noqa: A003
        level = record.levelname.upper()
        out = {
            "time": datetime.fromtimestamp(record.created, timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            # WARNING -> WARN so a level filter matches across all four services.
            "level": "WARN" if level == "WARNING" else level,
            "msg": record.getMessage(),
            "service": SERVICE,
        }
        rid = request_id_var.get()
        if rid:
            out["request_id"] = rid
        for field in _EXTRA_FIELDS:
            if field in record.__dict__:
                out[field] = record.__dict__[field]
        # logging.info("msg", extra={"fields": {...}}) is this language's version
        # of slog's key/value pairs — used by the startup config banner.
        extra_fields = record.__dict__.get("fields")
        if isinstance(extra_fields, dict):
            out.update(extra_fields)
        if record.exc_info:
            exc_type, exc_value, _ = record.exc_info
            out["err"] = f"{getattr(exc_type, '__name__', exc_type)}: {exc_value}"
            out["stack"] = "".join(traceback.format_exception(*record.exc_info)).strip()
        return json.dumps(out, default=str)


def setup_logging() -> None:
    """Install the JSON formatter on the root logger. LOG_LEVEL sets the level."""
    level = _LEVELS.get(os.environ.get("LOG_LEVEL", "").lower(), logging.INFO)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)

    # uvicorn installs its own plain-text handlers before importing the app.
    # Strip them so its lines come out as JSON like everything else...
    for name in ("uvicorn", "uvicorn.error"):
        lg = logging.getLogger(name)
        lg.handlers = []
        lg.propagate = True
    # ...except uvicorn.access, which would duplicate our own access line.
    access = logging.getLogger("uvicorn.access")
    access.handlers = []
    access.propagate = False


_log = logging.getLogger("agent_svc.access")


class AccessLogMiddleware:
    """One info line per request: method, path, status, duration_ms, ids.

    A raw ASGI middleware, not BaseHTTPMiddleware: /chat is a long-lived SSE
    stream and this must not sit between the generator and the socket. It only
    reads the response-start message for the status code.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = {k.lower(): v for k, v in scope.get("headers", [])}
        rid = sanitize_request_id(
            headers.get(b"x-request-id", b"").decode("latin-1", "replace")
        ) or new_request_id()
        token = request_id_var.set(rid)

        status = 500  # if the app raises before responding, that is what the client sees
        started = time.perf_counter()

        async def send_wrapper(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                message.setdefault("headers", []).append(
                    (b"x-request-id", rid.encode("ascii"))
                )
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            path = scope.get("path", "")
            # Health probes poll constantly; keep them out of the info stream.
            level = logging.DEBUG if path in ("/health", "/healthz") else logging.INFO
            extra = {
                "request_id": rid,
                "method": scope.get("method", ""),
                "path": path,
                "status": status,
                "duration_ms": round((time.perf_counter() - started) * 1000, 3),
            }
            # user_id rides the query string on every uid-scoped route. /chat
            # carries it in the body, which we never parse just to log it.
            uid = parse_qs(scope.get("query_string", b"").decode("latin-1", "replace")).get(
                "user_id"
            )
            if uid:
                extra["user_id"] = uid[0][:64]
            _log.log(level, "request", extra=extra)
            request_id_var.reset(token)


def secret_state(value: str | None) -> str:
    """Whether a secret is configured — never its value."""
    return "SET" if value else "UNSET"


def demo() -> None:
    assert sanitize_request_id("abc-123_x.y") == "abc-123_x.y"
    assert sanitize_request_id("bad id\n") == ""      # space + newline rejected
    assert sanitize_request_id("x" * 100) == "x" * 64  # bounded
    assert sanitize_request_id("") == ""
    assert len(new_request_id()) == 16

    rec = logging.LogRecord("t", logging.WARNING, __file__, 1, "hello", None, None)
    rec.__dict__.update({"status": 503, "user_id": "u1", "secret": "leak-me"})
    out = json.loads(JsonFormatter().format(rec))
    assert out["level"] == "WARN", out          # WARNING normalised to WARN
    assert out["service"] == SERVICE
    assert out["msg"] == "hello"
    assert out["status"] == 503 and out["user_id"] == "u1"
    assert "secret" not in out, out             # unknown extras never leak
    assert secret_state("") == "UNSET" and secret_state("x") == "SET"
    print("logsetup.py self-check OK")


if __name__ == "__main__":
    demo()
