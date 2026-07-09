import anthropic
import httpx
import openai
import pytest

import llm.resolver as resolver
from graph.workflow import stream_with_lifeboat
from llm.base import Capabilities


def _resp(status):
    return httpx.Response(status, request=httpx.Request("POST", "http://x"))


class FakeProvider:
    def __init__(self, exc=None, chunks=None, provider="anthropic", model="claude-opus-4-8"):
        self.exc = exc
        self.chunks = chunks or []
        self.provider = provider
        self.model = model

    def stream(self, messages, system=None, tools=None, max_tokens=1024):
        if self.exc:
            raise self.exc
        for c in self.chunks:
            yield c

    def capabilities(self):
        return Capabilities(1000, False, True, False)


def _collect():
    events = []
    return events, (lambda e, d: events.append((e, d)))


LIFEBOAT = FakeProvider(chunks=["hel", "lo"], provider="local", model="qwen2.5:7b")
MESSAGES = [{"role": "user", "content": "hi"}]


def _dead_cases():
    return [
        anthropic.AuthenticationError("no", response=_resp(401), body=None),
        anthropic.PermissionDeniedError("no", response=_resp(403), body=None),
        anthropic.APIStatusError("payment", response=_resp(402), body=None),
        openai.AuthenticationError("no", response=_resp(401), body=None),
        openai.PermissionDeniedError("no", response=_resp(403), body=None),
    ]


def _transient_cases():
    req = httpx.Request("POST", "http://x")
    return [
        anthropic.RateLimitError("rl", response=_resp(429), body=None),
        anthropic.APIStatusError("boom", response=_resp(500), body=None),
        anthropic.APITimeoutError(req),
        anthropic.APIConnectionError(request=req),
    ]


@pytest.mark.parametrize("exc", _dead_cases())
def test_lifeboat_fires_on_dead_credential(exc):
    active = FakeProvider(exc=exc)
    events, emit = _collect()
    res = stream_with_lifeboat("u", active, MESSAGES, "sys", emit, lifeboat_fn=lambda: LIFEBOAT)

    assert res["degraded"] is True
    assert res["failed"] is False
    assert res["answer"] == "hello"
    assert res["model"] == "qwen2.5:7b"
    assert res["provider_name"] == "local"

    kinds = [e for e, _ in events]
    assert "degraded" in kinds
    assert "error" not in kinds
    # The degraded event names the model that actually answered.
    degraded = next(d for e, d in events if e == "degraded")
    assert degraded["provider"] == "local"
    assert degraded["model"] == "qwen2.5:7b"


@pytest.mark.parametrize("exc", _transient_cases())
def test_lifeboat_does_not_fire_on_transient(exc):
    active = FakeProvider(exc=exc)
    events, emit = _collect()
    called = {"n": 0}

    def lifeboat_fn():
        called["n"] += 1
        return LIFEBOAT

    res = stream_with_lifeboat("u", active, MESSAGES, "sys", emit, lifeboat_fn=lifeboat_fn)

    assert res["failed"] is True
    assert res["degraded"] is False
    assert called["n"] == 0  # lifeboat was never even consulted
    kinds = [e for e, _ in events]
    assert "error" in kinds
    assert "degraded" not in kinds


def test_lifeboat_never_mutates_is_active():
    # There is deliberately no code path that flips is_active — the resolver
    # exposes no activate/set_active call.
    assert not hasattr(resolver, "activate")
    assert not hasattr(resolver, "set_active")

    active = FakeProvider(exc=_dead_cases()[0])
    events, emit = _collect()
    res = stream_with_lifeboat("u", active, MESSAGES, "sys", emit, lifeboat_fn=lambda: LIFEBOAT)
    assert res["degraded"] is True
    # No mutation event of any kind was emitted; only degraded + tokens + (later) done.
    assert all(e in ("degraded", "token") for e, _ in events)
