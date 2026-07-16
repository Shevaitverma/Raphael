"""Tools reach the wire; provider tool-call ids never come back off it.

Fully offline. Until now no call site anywhere passed tools=, so chat()
accepted the argument and dropped it on the floor and openai_compat hardcoded
tool_calls=[] — every assertion here covers a path that has never run.

The id is the point. constraint: nothing shaped like a provider wire format may
reach a caller, because conv-svc validates the column and e2e.sh section 5
stringifies it and bans the literal "id" as raw text.
"""
import json
from types import SimpleNamespace

import httpx
import pytest
from openai import BadRequestError

from llm import openai_compat
from llm.anthropic_api import AnthropicAPIProvider
from llm.openai_compat import OpenAICompatProvider

WEB_SEARCH = {
    "name": "web_search",
    "description": "Search the live web.",
    "parameters": {
        "type": "object",
        "properties": {"query": {"type": "string"}, "count": {"type": "integer"}},
    },
}


# --- fakes --------------------------------------------------------------------

def _resp(text="", tool_calls=(), finish="stop"):
    msg = SimpleNamespace(content=text, reasoning="", tool_calls=list(tool_calls))
    return SimpleNamespace(choices=[SimpleNamespace(message=msg, finish_reason=finish)])


def _tc(id, name, arguments):
    """An openai SDK tool_call, ids and all — exactly what we must not echo."""
    return SimpleNamespace(id=id, type="function", function=SimpleNamespace(name=name, arguments=arguments))


def _400(param):
    req = httpx.Request("POST", "http://x/v1/chat/completions")
    return BadRequestError(f"unsupported parameter: {param}", response=httpx.Response(400, request=req), body=None)


class FakeCompletions:
    def __init__(self, rejects=(), replies=None):
        self.rejects, self.replies, self.calls = set(rejects), list(replies or [_resp("ok")]), []

    def create(self, **kw):
        self.calls.append(kw)
        bad = self.rejects & set(kw)
        if bad:
            raise _400(sorted(bad)[0])
        return self.replies[min(len(self.calls) - 1, len(self.replies) - 1)]


def _provider(monkeypatch, rejects=(), replies=None):
    p = OpenAICompatProvider(
        base_url="http://localhost:11434/v1", api_key="ollama", model="qwen3.5:latest", backend="ollama"
    )
    fake = FakeCompletions(rejects, replies)
    monkeypatch.setattr(p, "_client", SimpleNamespace(chat=SimpleNamespace(completions=fake)))
    return p, fake


class FakeMessages:
    def __init__(self, resp):
        self.resp, self.calls = resp, []

    def create(self, **kw):
        self.calls.append(kw)
        return self.resp


def _anthropic(monkeypatch, resp=None):
    p = AnthropicAPIProvider(api_key="sk-x", model="claude-opus-4-8")
    fake = FakeMessages(resp or SimpleNamespace(stop_reason="end_turn", content=[]))
    monkeypatch.setattr(p, "_client", SimpleNamespace(messages=fake))
    return p, fake


@pytest.fixture(autouse=True)
def _no_unsupported_memo():
    openai_compat._UNSUPPORTED.clear()
    yield
    openai_compat._UNSUPPORTED.clear()


def _keys(o):
    """Every key at every depth — an id nested inside arguments still fails e2e."""
    if isinstance(o, dict):
        for k, v in o.items():
            yield k
            yield from _keys(v)
    elif isinstance(o, list):
        for v in o:
            yield from _keys(v)


# --- 1. tools reach the wire on both adapters ---------------------------------

def test_openai_compat_puts_tools_on_the_wire(monkeypatch):
    p, fake = _provider(monkeypatch)
    p.chat([{"role": "user", "content": "hi"}], tools=[WEB_SEARCH])

    assert fake.calls[0]["tools"] == [{"type": "function", "function": WEB_SEARCH}]


def test_anthropic_puts_tools_on_the_wire(monkeypatch):
    p, fake = _anthropic(monkeypatch)
    p.chat([{"role": "user", "content": "hi"}], tools=[WEB_SEARCH])

    # Same schema object, Anthropic's name for it.
    assert fake.calls[0]["tools"] == [
        {"name": "web_search", "description": "Search the live web.", "input_schema": WEB_SEARCH["parameters"]}
    ]


# --- 2. absent is not empty ---------------------------------------------------

def test_anthropic_params_omits_tools_entirely_when_none(monkeypatch):
    p, _ = _anthropic(monkeypatch)
    assert "tools" not in p._params([{"role": "user", "content": "hi"}], None, 1024)
    assert "tools" not in p._params([{"role": "user", "content": "hi"}], None, 1024, tools=[])


def test_openai_compat_omits_tools_entirely_when_none(monkeypatch):
    p, fake = _provider(monkeypatch)
    p.chat([{"role": "user", "content": "hi"}])
    assert "tools" not in fake.calls[0]


def test_stream_is_untouched_by_tools(monkeypatch):
    """stream() has none of chat()'s 400 ladder; the pre-flight design means it
    never needs tools. If this starts failing, that decision was reversed."""
    p, fake = _provider(monkeypatch)
    fake.replies = [iter(())]
    list(p.stream([{"role": "user", "content": "hi"}], tools=[WEB_SEARCH]))
    assert "tools" not in fake.calls[0]


# --- 3. the provider's call_ id dies at this boundary -------------------------

def test_tool_call_id_never_survives_translation(monkeypatch):
    p, _ = _provider(
        monkeypatch,
        replies=[_resp("", [_tc("call_abc123", "web_search", '{"query": "x"}')], finish="tool_calls")],
    )
    r = p.chat([{"role": "user", "content": "hi"}], tools=[WEB_SEARCH])

    assert r.tool_calls == [{"name": "web_search", "arguments": {"query": "x"}}]
    assert "id" not in set(_keys(r.tool_calls))  # at ANY depth
    blob = json.dumps({"role": "assistant", "content": r.text, "tool_calls": r.tool_calls})
    assert "call_abc123" not in blob and "call_" not in blob


# --- 4. a model that writes garbage arguments breaks nothing -------------------

def test_malformed_arguments_yield_no_tool_calls_and_do_not_raise(monkeypatch):
    p, _ = _provider(
        monkeypatch,
        replies=[_resp("", [_tc("call_1", "web_search", '{"query": "x"')], finish="tool_calls")],
    )
    r = p.chat([{"role": "user", "content": "hi"}], tools=[WEB_SEARCH])
    assert r.tool_calls == []  # the caller retries; it never sees an exception


def test_non_object_arguments_yield_no_tool_calls(monkeypatch):
    """Valid JSON, wrong shape. `arguments.get(...)` must never meet a list."""
    p, _ = _provider(monkeypatch, replies=[_resp("", [_tc("call_1", "web_search", "[1, 2]")])])
    assert p.chat([{"role": "user", "content": "hi"}], tools=[WEB_SEARCH]).tool_calls == []


def test_no_tool_calls_is_the_normal_empty_case(monkeypatch):
    p, _ = _provider(monkeypatch, replies=[_resp("just an answer")])
    r = p.chat([{"role": "user", "content": "hi"}], tools=[WEB_SEARCH])
    assert r.text == "just an answer" and r.tool_calls == []


# --- 5. a deployment that 400s on tools demotes, it does not raise -------------

def test_400_on_tools_memoizes_and_the_retry_still_answers(monkeypatch):
    p, fake = _provider(monkeypatch, rejects={"tools"}, replies=[None, _resp("ungrounded answer")])
    r = p.chat([{"role": "user", "content": "hi"}], tools=[WEB_SEARCH])

    assert r.text == "ungrounded answer"  # Tier 1 -> Tier 2, no exception
    assert r.tool_calls == []
    assert len(fake.calls) == 2 and "tools" not in fake.calls[1]
    assert (p.base_url, p.model, "tools") in openai_compat._UNSUPPORTED


def test_a_tool_less_deployment_is_asked_exactly_once(monkeypatch):
    p, fake = _provider(monkeypatch, rejects={"tools"}, replies=[None, _resp("a"), _resp("a"), _resp("a")])
    for _ in range(3):
        p.chat([{"role": "user", "content": "hi"}], tools=[WEB_SEARCH])

    assert len(fake.calls) == 4  # attempt + retry, then never re-asked
    assert not any("tools" in c for c in fake.calls[1:])


def test_a_real_400_still_raises(monkeypatch):
    """Out of optional params, a 400 is the caller's problem — as before."""
    p, _ = _provider(monkeypatch, rejects={"model"})
    with pytest.raises(BadRequestError):
        p.chat([{"role": "user", "content": "hi"}], tools=[WEB_SEARCH])
