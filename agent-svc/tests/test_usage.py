"""Token-usage capture on the streaming providers. Fully offline — fake clients,
no Ollama, no Anthropic, no network.

Property under test: after stream() drains, provider.last_usage holds the SDK's
prompt/completion counts, or None when the SDK reported none, and it is always
reset at stream start so a caller never reads a stale prior turn.
"""
import types

from llm.anthropic_api import AnthropicAPIProvider
from llm.openai_compat import OpenAICompatProvider


def _delta(text):
    return types.SimpleNamespace(choices=[types.SimpleNamespace(delta=types.SimpleNamespace(content=text))], usage=None)


def _usage_chunk(pt, ct):
    # The final usage chunk carries empty choices and a .usage object.
    return types.SimpleNamespace(choices=[], usage=types.SimpleNamespace(prompt_tokens=pt, completion_tokens=ct))


class _FakeCompletions:
    def __init__(self, chunks):
        self._chunks = chunks

    def create(self, **_kw):
        return iter(self._chunks)


class _FakeOpenAI:
    def __init__(self, chunks):
        self.chat = types.SimpleNamespace(completions=_FakeCompletions(chunks))


def _provider(chunks):
    p = OpenAICompatProvider(base_url="http://x/v1", api_key="k", model="m")
    p._client = _FakeOpenAI(chunks)
    return p


def test_final_chunk_usage_sets_last_usage():
    p = _provider([_delta("hel"), _delta("lo"), _usage_chunk(11, 7)])
    out = "".join(p.stream([{"role": "user", "content": "hi"}]))
    assert out == "hello"
    assert p.last_usage == {"prompt_tokens": 11, "completion_tokens": 7}


def test_no_usage_chunk_leaves_none():
    p = _provider([_delta("hi")])
    list(p.stream([{"role": "user", "content": "hi"}]))
    assert p.last_usage is None


def test_last_usage_resets_at_stream_start():
    p = _provider([_usage_chunk(1, 2)])
    list(p.stream([{"role": "user", "content": "a"}]))
    assert p.last_usage == {"prompt_tokens": 1, "completion_tokens": 2}
    # A second stream with no usage chunk must clear the stale value.
    p._client = _FakeOpenAI([_delta("x")])
    list(p.stream([{"role": "user", "content": "b"}]))
    assert p.last_usage is None


# --- Anthropic path: fake the .stream() context manager. -------------------
class _FakeAnthStream:
    def __init__(self, deltas, usage):
        self.text_stream = iter(deltas)
        self._usage = usage

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get_final_message(self):
        if self._usage is None:
            raise RuntimeError("no final message")
        return types.SimpleNamespace(usage=self._usage)


def _anth_provider(deltas, usage):
    p = AnthropicAPIProvider(api_key="k")
    p._client = types.SimpleNamespace(
        messages=types.SimpleNamespace(stream=lambda **_kw: _FakeAnthStream(deltas, usage))
    )
    return p


def test_anthropic_final_message_usage():
    p = _anth_provider(["he", "llo"], types.SimpleNamespace(input_tokens=20, output_tokens=5))
    out = "".join(p.stream([{"role": "user", "content": "hi"}]))
    assert out == "hello"
    assert p.last_usage == {"prompt_tokens": 20, "completion_tokens": 5}


def test_anthropic_usage_failure_leaves_none():
    p = _anth_provider(["hi"], usage=None)  # get_final_message raises -> None, no break
    out = "".join(p.stream([{"role": "user", "content": "hi"}]))
    assert out == "hi"
    assert p.last_usage is None
