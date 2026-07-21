"""Offline tests for the degraded Claude OAuth path (anthropic_cli.py).

No network, no claude-agent-sdk: a fake _load_sdk supplies the SDK types so the
async->queue->sync bridge and prompt flattening are exercised in pure Python.
Guards the provider-portable fallback tier (completion-only, native_tools=False).
"""
import pytest

from llm import anthropic_cli
from llm.anthropic_cli import AnthropicCLIProvider


# --- fake SDK types (shape the adapter relies on) --------------------------
class _Text:
    def __init__(self, text):
        self.text = text


class _Assistant:
    def __init__(self, content):
        self.content = content


class _Options:
    def __init__(self, **kw):
        self.kw = kw


def _fake_sdk(query):
    """Return a _load_sdk replacement handing back (query, Options, Assistant, Text)."""
    return lambda: (query, _Options, _Assistant, _Text)


# --- _prompt flattening ----------------------------------------------------
def test_prompt_flattens_neutral_history():
    p = AnthropicCLIProvider(oauth_token="tok")
    prompt = p._prompt(
        [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "hello"},
            {"role": "tool", "content": "42"},
            {"role": "user", "content": None},  # missing content -> ""
        ],
        system=None,
    )
    assert prompt == "hi\n\nassistant: hello\n\ntool: 42\n\n"


# --- stream() bridge: happy path + sentinel termination --------------------
def test_stream_yields_and_sentinel_terminates(monkeypatch):
    async def query(prompt, options):
        yield _Assistant([_Text("hello "), _Text(""), _Text("world")])

    monkeypatch.setattr(anthropic_cli, "_load_sdk", _fake_sdk(query))
    p = AnthropicCLIProvider(oauth_token="tok")
    # If the sentinel didn't terminate, list() would hang; it returns => terminated.
    assert list(p.stream([{"role": "user", "content": "x"}])) == ["hello ", "world"]


# --- exception in async body propagates through the queue bridge -----------
def test_stream_propagates_async_exception(monkeypatch):
    async def query(prompt, options):
        if False:  # make this an async generator
            yield _Assistant([])
        raise RuntimeError("boom")

    monkeypatch.setattr(anthropic_cli, "_load_sdk", _fake_sdk(query))
    p = AnthropicCLIProvider(oauth_token="tok")
    with pytest.raises(RuntimeError, match="boom"):
        list(p.stream([{"role": "user", "content": "x"}]))


# --- chat() assembles a ChatResponse with stop_reason='end_turn' -----------
def test_chat_returns_end_turn(monkeypatch):
    async def query(prompt, options):
        yield _Assistant([_Text("done")])

    monkeypatch.setattr(anthropic_cli, "_load_sdk", _fake_sdk(query))
    p = AnthropicCLIProvider(oauth_token="tok", model="claude-opus-4-8")
    r = p.chat([{"role": "user", "content": "x"}])
    assert r.text == "done"
    assert r.stop_reason == "end_turn"
    assert r.provider == "anthropic"
    assert r.model == "claude-opus-4-8"
    assert r.tool_calls == []
