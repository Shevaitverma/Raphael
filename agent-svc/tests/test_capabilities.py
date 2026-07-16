"""Capability honesty. Fully offline — no Ollama, no network.

The old version of this file PINNED THE BUG: it asserted the substring table
(`"qwen2.5" in model`), so the installed qwen3.5:latest reporting
native_tools=False was a passing test. What we assert now is the property that
actually matters: we never claim more than we were told.
"""
import httpx
import pytest
from openai import BadRequestError

from llm import openai_compat
from llm.anthropic_api import AnthropicAPIProvider
from llm.base import Capabilities
from llm.openai_compat import OpenAICompatProvider

FLOOR = Capabilities()

# Shape copied from a live `curl http://localhost:11434/api/tags`.
TAGS = {
    "models": [
        {
            "name": "qwen3.5:latest",
            "model": "qwen3.5:latest",
            "details": {"family": "qwen35", "context_length": 262144},
            "capabilities": ["vision", "completion", "tools", "thinking"],
        },
        {
            "name": "llama2:latest",
            "model": "llama2:latest",
            "details": {"family": "llama", "context_length": 4096},
            "capabilities": ["completion"],
        },
    ]
}

# Shape copied from a live `curl https://openrouter.ai/api/v1/models`.
OR_MODELS = {
    "data": [
        {
            "id": "moonshotai/kimi-k3",
            "context_length": 1048576,
            "architecture": {"input_modalities": ["text", "image"]},
            "supported_parameters": ["tools", "response_format", "structured_outputs"],
        }
    ]
}


@pytest.fixture(autouse=True)
def _no_cache():
    """lru_cache would leak one test's stub into the next."""
    openai_compat._discover.cache_clear()
    yield
    openai_compat._discover.cache_clear()


def _stub(monkeypatch, payload=None, exc=None):
    def fake_get(url, **kw):
        if exc:
            raise exc
        return httpx.Response(200, json=payload, request=httpx.Request("GET", url))

    monkeypatch.setattr(openai_compat.httpx, "get", fake_get)


def _local(model):
    return OpenAICompatProvider(
        base_url="http://localhost:11434/v1", api_key="ollama", model=model, backend="ollama"
    )


def _remote(model):
    return OpenAICompatProvider(
        base_url="https://openrouter.ai/api/v1", api_key="k", model=model, backend="openrouter"
    )


# --- unreachable server: exactly the floor, honestly labelled -----------------

def test_unreachable_yields_exactly_the_floor(monkeypatch):
    _stub(monkeypatch, exc=httpx.ConnectError("refused"))
    c = _local("qwen3.5:latest").capabilities()

    assert c.source == "default"
    assert c.max_context_tokens == FLOOR.max_context_tokens == 8192
    assert c.native_tools is False
    assert c.json_schema is False
    assert c.vision is False
    assert c.streaming is True


def test_unreachable_openrouter_yields_the_floor(monkeypatch):
    _stub(monkeypatch, exc=httpx.ConnectError("refused"))
    assert _remote("moonshotai/kimi-k3").capabilities().source == "default"


def test_garbage_payload_yields_the_floor(monkeypatch):
    _stub(monkeypatch, payload={"models": "not-a-list"})
    assert _local("qwen3.5:latest").capabilities().source == "default"


def test_model_not_pulled_yields_the_floor(monkeypatch):
    """Absent from the catalogue means we know nothing — claim nothing."""
    _stub(monkeypatch, payload=TAGS)
    c = _local("mistral:7b").capabilities()
    assert c.source == "default"
    assert c.native_tools is False


# --- discovery: believe the server, not the table -----------------------------

def test_discovers_native_tools_the_static_table_got_wrong(monkeypatch):
    """The regression: `"qwen2.5" in model` reported False for this model."""
    _stub(monkeypatch, payload=TAGS)
    c = _local("qwen3.5:latest").capabilities()

    assert c.source == "discovered"
    assert c.native_tools is True
    assert c.vision is True
    assert c.model_id == "qwen3.5:latest"


def test_discovers_absent_capabilities_as_false(monkeypatch):
    _stub(monkeypatch, payload=TAGS)
    c = _local("llama2:latest").capabilities()
    assert c.source == "discovered"
    assert c.native_tools is False
    assert c.vision is False


def test_untagged_model_name_matches_latest(monkeypatch):
    _stub(monkeypatch, payload=TAGS)
    assert _local("qwen3.5").capabilities().native_tools is True


def test_openrouter_discovery(monkeypatch):
    _stub(monkeypatch, payload=OR_MODELS)
    c = _remote("moonshotai/kimi-k3").capabilities()

    assert c.source == "discovered"
    assert c.max_context_tokens == 1_048_576  # not the old hardcoded 32768
    assert c.native_tools is True
    assert c.json_schema is True
    assert c.vision is True


# --- the clamp: served window = min(trained, num_ctx) --------------------------

def test_num_ctx_clamps_the_trained_window(monkeypatch):
    """262144 trained, but Ollama serves num_ctx and truncates in SILENCE."""
    _stub(monkeypatch, payload=TAGS)
    monkeypatch.setattr(openai_compat, "OLLAMA_NUM_CTX", 4096)
    assert _local("qwen3.5:latest").capabilities().max_context_tokens == 4096


def test_clamp_takes_the_smaller_of_the_two(monkeypatch):
    """num_ctx raised above what the model was trained for: trained wins."""
    _stub(monkeypatch, payload=TAGS)
    monkeypatch.setattr(openai_compat, "OLLAMA_NUM_CTX", 999_999)
    assert _local("qwen3.5:latest").capabilities().max_context_tokens == 262144


def test_openrouter_is_not_clamped_by_a_local_knob(monkeypatch):
    _stub(monkeypatch, payload=OR_MODELS)
    monkeypatch.setattr(openai_compat, "OLLAMA_NUM_CTX", 4096)
    assert _remote("moonshotai/kimi-k3").capabilities().max_context_tokens == 1_048_576


# --- discovery must never raise into a chat request ---------------------------

def test_discovery_never_raises(monkeypatch):
    for exc in (httpx.ConnectError("x"), httpx.ReadTimeout("x"), ValueError("bad json")):
        openai_compat._discover.cache_clear()
        _stub(monkeypatch, exc=exc)
        assert _local("qwen3.5:latest").capabilities().source == "default"


# --- conservative defaults: a forgotten field cannot over-promise --------------

def test_floor_is_conservative():
    assert FLOOR.max_context_tokens == 8192
    assert FLOOR.native_tools is False
    assert FLOOR.json_schema is False
    assert FLOOR.vision is False
    assert FLOOR.streaming is True
    assert FLOOR.source == "default"
    assert FLOOR.model_id == ""


# --- anthropic ----------------------------------------------------------------

# --- optional chat params: attempt, remember the 400, never raise into a turn --

def _resp(content, finish="stop", reasoning=""):
    msg = type("M", (), {"content": content, "reasoning": reasoning})()
    choice = type("C", (), {"message": msg, "finish_reason": finish})()
    return type("R", (), {"choices": [choice]})()


def _400(param):
    """A server rejecting one unsupported param, exactly as OpenRouter would."""
    req = httpx.Request("POST", "http://x/v1/chat/completions")
    return BadRequestError(
        f"unsupported parameter: {param}",
        response=httpx.Response(400, request=req),
        body=None,
    )


class FakeCompletions:
    """Records every attempt; raises for params listed in `rejects`."""

    def __init__(self, rejects=(), reply=None):
        self.rejects, self.reply, self.calls = set(rejects), reply or _resp("{}"), []

    def create(self, **kw):
        self.calls.append(kw)
        sent = set(kw) | set(kw.get("extra_body") or {})
        bad = self.rejects & sent
        if bad:
            raise _400(sorted(bad)[0])
        return self.reply


def _provider(monkeypatch, rejects=(), reply=None, model="qwen3.5:latest"):
    p = _local(model)
    fake = FakeCompletions(rejects, reply)
    monkeypatch.setattr(p, "_client", type("Cl", (), {"chat": type("Ch", (), {"completions": fake})()})())
    return p, fake


@pytest.fixture(autouse=True)
def _no_unsupported_memo():
    """The memo is module-level and would leak between tests."""
    openai_compat._UNSUPPORTED.clear()
    yield
    openai_compat._UNSUPPORTED.clear()


def test_defaults_send_no_optional_params(monkeypatch):
    """Every existing caller must go out byte for byte as before."""
    p, fake = _provider(monkeypatch)
    p.chat([{"role": "user", "content": "hi"}])
    assert "extra_body" not in fake.calls[0] and "response_format" not in fake.calls[0]


def test_reasoning_false_disables_thinking(monkeypatch):
    """THE REGRESSION: a thinking model returns content='' until it stops
    deliberating, so extraction must be able to turn it off."""
    p, fake = _provider(monkeypatch)
    p.chat([{"role": "user", "content": "hi"}], json_mode=True, reasoning=False)

    assert fake.calls[0]["extra_body"] == {"reasoning_effort": "none"}
    assert fake.calls[0]["response_format"] == {"type": "json_object"}


def test_400_on_reasoning_effort_retries_without_it_and_keeps_json_mode(monkeypatch):
    p, fake = _provider(monkeypatch, rejects={"reasoning_effort"}, reply=_resp('{"items": []}'))
    r = p.chat([{"role": "user", "content": "hi"}], json_mode=True, reasoning=False)

    assert r.text == '{"items": []}'  # the 400 never reached the caller
    assert len(fake.calls) == 2
    assert "extra_body" not in fake.calls[1]
    assert fake.calls[1]["response_format"] == {"type": "json_object"}  # not collateral damage


def test_the_rejected_param_is_paid_for_once_per_process(monkeypatch):
    p, fake = _provider(monkeypatch, rejects={"reasoning_effort"})
    for _ in range(3):
        p.chat([{"role": "user", "content": "hi"}], json_mode=True, reasoning=False)

    # 2 for the first call (attempt + retry), then 1 each — never re-asked.
    assert len(fake.calls) == 4
    assert not any("extra_body" in c for c in fake.calls[1:])


def test_a_server_rejecting_both_params_still_answers(monkeypatch):
    p, fake = _provider(monkeypatch, rejects={"reasoning_effort", "response_format"}, reply=_resp("plain"))
    assert p.chat([{"role": "user", "content": "hi"}], json_mode=True, reasoning=False).text == "plain"
    assert len(fake.calls) == 3  # both -> drop reasoning -> drop json -> answers


def test_a_real_400_still_raises(monkeypatch):
    """Once the optional params are gone, a 400 is the caller's problem."""
    p, _ = _provider(monkeypatch, rejects={"model"})
    with pytest.raises(BadRequestError):
        p.chat([{"role": "user", "content": "hi"}], json_mode=True, reasoning=False)


def test_unsupported_is_remembered_per_deployment(monkeypatch):
    """The same model id on two servers is not the same deployment."""
    p, _ = _provider(monkeypatch, rejects={"reasoning_effort"})
    p.chat([{"role": "user", "content": "hi"}], reasoning=False)

    other = _remote("qwen3.5:latest")
    assert (other.base_url, other.model, "reasoning_effort") not in openai_compat._UNSUPPORTED


def test_empty_content_at_the_token_cap_is_not_silent(monkeypatch, caplog):
    """The deeper defect: '' from truncation must not look like '' from silence."""
    p, _ = _provider(monkeypatch, reply=_resp("", finish="length", reasoning="thinking..."))
    with caplog.at_level("WARNING"):
        r = p.chat([{"role": "user", "content": "hi"}])

    assert r.text == "" and r.stop_reason == "length"  # still never raises
    assert "truncated" in caplog.text.lower()


def test_anthropic_does_not_claim_json_schema():
    """Anthropic has no response_format; coercion is forced tool-use, which
    nothing implements. Claiming it was a lie."""
    c = AnthropicAPIProvider(api_key="sk-x", model="claude-opus-4-8").capabilities()

    assert c.json_schema is False
    assert c.native_tools is True
    assert c.streaming is True
    assert c.max_context_tokens >= 200_000
    assert c.source == "static"  # hardcoded, and says so
