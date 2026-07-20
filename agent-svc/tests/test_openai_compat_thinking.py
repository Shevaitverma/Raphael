"""Thinking-model extraction fix: reasoning=False must actually stop a thinking
model from thinking, provider-portably, and inline <think> must be stripped.

Fake client only — no server, no network.
"""
from types import SimpleNamespace

from openai import BadRequestError

from llm import openai_compat
from llm.openai_compat import OpenAICompatProvider, _strip_leading_think


def _msg(content, tool_calls=None):
    return SimpleNamespace(content=content, tool_calls=tool_calls, reasoning=None)


def _resp(content, finish="stop"):
    return SimpleNamespace(choices=[SimpleNamespace(message=_msg(content), finish_reason=finish)])


class _FakeCompletions:
    """Records the last kwargs and can be told to 400 on a given param once."""

    def __init__(self, reply="ok", raise_on=None):
        self.reply, self.raise_on, self.calls = reply, raise_on, []

    def create(self, **kw):
        self.calls.append(kw)
        if self.raise_on and self.raise_on in kw.get("extra_body", {}):
            self.raise_on = None  # 400 once, then succeed on retry
            raise BadRequestError.__new__(BadRequestError)
        return _resp(self.reply)


def _provider(backend="ollama", **fake):
    p = OpenAICompatProvider("http://x/v1", "k", "qwen3.5", backend=backend)
    p._client = SimpleNamespace(chat=SimpleNamespace(completions=_FakeCompletions(**fake)))
    return p


def test_ollama_reasoning_off_sends_both_knobs():
    p = _provider(backend="ollama")
    p.chat([{"role": "user", "content": "hi"}], reasoning=False)
    body = p._client.chat.completions.calls[0]["extra_body"]
    assert body == {"reasoning_effort": "none", "think": False}, body


def test_openrouter_reasoning_off_sends_effort_only():
    # `think` is Ollama-native; sending it to OpenRouter would 400, so we don't.
    p = _provider(backend="openrouter")
    p.chat([{"role": "user", "content": "hi"}], reasoning=False)
    assert p._client.chat.completions.calls[0]["extra_body"] == {"reasoning_effort": "none"}


def test_reasoning_on_sends_no_knob():
    p = _provider()
    p.chat([{"role": "user", "content": "hi"}], reasoning=True)
    assert "extra_body" not in p._client.chat.completions.calls[0]


def test_inline_think_prefix_is_stripped():
    assert _strip_leading_think("<think>plan the answer</think>\n{\"x\":1}") == '{"x":1}'
    p = _provider(reply="<think>deliberating…</think>  hello")
    assert p.chat([{"role": "user", "content": "hi"}], reasoning=False).text == "hello"


def test_unsupported_param_dropped_on_retry_not_raised():
    openai_compat._UNSUPPORTED.clear()
    # Server 400s on the reasoning knob once; chat() must demote and succeed.
    p = _provider(backend="ollama", reply="done", raise_on="reasoning_effort")
    out = p.chat([{"role": "user", "content": "hi"}], reasoning=False)
    assert out.text == "done"
    assert ("http://x/v1", "qwen3.5", "reasoning_effort") in openai_compat._UNSUPPORTED
    assert "extra_body" not in p._client.chat.completions.calls[-1]  # retried without it


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
