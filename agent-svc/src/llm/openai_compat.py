"""OpenAI-compatible chat via the `openai` SDK with a base_url.

Serves BOTH Ollama (http://localhost:11434/v1) and OpenRouter. Streaming uses
chat.completions with stream=True.

capabilities() ASKS THE SERVER rather than consulting a table. Both catalogues
are unauthenticated GETs (verified live: Ollama /api/tags reports
capabilities:["vision","completion","tools","thinking"] and
details.context_length; OpenRouter /api/v1/models returns 344 models with
context_length + supported_parameters). Discovery is cached and can never raise
into a chat request — ANY failure yields the conservative floor from base.py.

The table this replaced was `return "qwen2.5" in model`, which reported
native_tools=False for the installed qwen3.5:latest. Static tables rot; the
server does not.
"""
from __future__ import annotations

import json
import logging
from functools import lru_cache

import httpx
from openai import BadRequestError, OpenAI

from config import OLLAMA_NUM_CTX
from llm.base import Capabilities, ChatResponse

_TIMEOUT = 3.0
_log = logging.getLogger(__name__)

# (base_url, model, param) triples the server 400s on. Same policy as
# capabilities(): ASK, then believe the answer. Paid once per process.
# Keyed by base_url too — the same model id on Ollama and OpenRouter is not the
# same deployment and need not accept the same params.
_UNSUPPORTED: set[tuple[str, str, str]] = set()


def _ollama_caps(base_url: str, model: str) -> Capabilities | None:
    """GET {root}/api/tags. Returns None if the server or the model is absent."""
    root = base_url.rstrip("/")
    if root.endswith("/v1"):
        root = root[: -len("/v1")]
    r = httpx.get(f"{root}/api/tags", timeout=_TIMEOUT)
    r.raise_for_status()
    models = r.json().get("models") or []
    want = {model, f"{model}:latest"}
    entry = next((m for m in models if want & {m.get("name"), m.get("model")}), None)
    if entry is None:
        return None  # model not pulled: we know nothing, so claim nothing.

    caps = entry.get("capabilities") or []
    # context_length lives under details, NOT at the top level.
    trained = (entry.get("details") or {}).get("context_length")
    floor = Capabilities()
    return Capabilities(
        # SERVED window = min(trained, num_ctx). The endpoint cannot see the
        # server's own num_ctx default, so the operator's knob is the authority.
        max_context_tokens=min(int(trained), OLLAMA_NUM_CTX) if trained else floor.max_context_tokens,
        native_tools="tools" in caps,
        streaming=True,
        # /api/tags says nothing about structured output, so neither do we.
        json_schema=False,
        vision="vision" in caps,
        model_id=model,
        source="discovered",
    )


def _openrouter_caps(base_url: str, model: str) -> Capabilities | None:
    """GET {base}/models. Returns None if the model is not in the catalogue."""
    r = httpx.get(f"{base_url.rstrip('/')}/models", timeout=_TIMEOUT)
    r.raise_for_status()
    entry = next((m for m in r.json().get("data") or [] if m.get("id") == model), None)
    if entry is None:
        return None

    params = entry.get("supported_parameters") or []
    modalities = (entry.get("architecture") or {}).get("input_modalities") or []
    ctx = entry.get("context_length")
    floor = Capabilities()
    return Capabilities(
        max_context_tokens=int(ctx) if ctx else floor.max_context_tokens,
        native_tools="tools" in params,
        streaming=True,
        json_schema="structured_outputs" in params,
        vision="image" in modalities,
        model_id=model,
        source="discovered",
    )


@lru_cache(maxsize=64)
def _discover(base_url: str, model: str, backend: str) -> Capabilities:
    """Never raises. On ANY failure the caller gets the floor, source='default'.

    ponytail: cached for process lifetime — a pulled model or a changed num_ctx
    needs a restart to show up. Add a TTL when models change under a live server.
    """
    if not model:
        return Capabilities()
    try:
        found = _ollama_caps(base_url, model) if backend == "ollama" else _openrouter_caps(base_url, model)
    except Exception:
        return Capabilities(model_id=model)  # unreachable/garbage -> the floor.
    return found or Capabilities(model_id=model)


def _neutral_tool_calls(message, model: str) -> list:
    """wire -> canonical. The provider's `call_...` id dies HERE; only
    {name, arguments} may go upstream.

    `arguments` is a STRING the model wrote, so it is untrusted: anything that
    is not a JSON object means we do not know what was asked, and guessing is
    worse than not calling. Drop the whole set and let the caller retry.
    """
    out = []
    for tc in getattr(message, "tool_calls", None) or []:
        fn = getattr(tc, "function", None)
        try:
            args = json.loads(getattr(fn, "arguments", None) or "{}")
        except ValueError:
            args = None
        if not isinstance(args, dict):
            _log.warning("%s emitted unparseable tool arguments; no tool_calls", model)
            return []
        out.append({"name": getattr(fn, "name", None), "arguments": args})
    return out


class OpenAICompatProvider:
    def __init__(self, base_url, api_key, model, backend="ollama"):
        self.model = model
        self.backend = backend  # "ollama" | "openrouter"
        self.base_url = base_url
        # provider name follows the credential kind, not the wire protocol.
        self.provider = "local" if backend == "ollama" else "openai_compat"
        # Ollama ignores the key but the SDK requires a non-empty string.
        self._client = OpenAI(base_url=base_url, api_key=api_key or "ollama")

    def capabilities(self) -> Capabilities:
        return _discover(self.base_url, self.model, self.backend)

    def _messages(self, messages, system) -> list:
        out = []
        if system:
            out.append({"role": "system", "content": system})
        for m in messages:
            out.append({"role": m["role"], "content": m["content"]})
        return out

    def _optional(self, json_mode: bool, reasoning: bool, tools) -> dict:
        """Optional params minus the ones this deployment already rejected."""
        kw = {}
        if tools and (self.base_url, self.model, "tools") not in _UNSUPPORTED:
            kw["tools"] = [{"type": "function", "function": t} for t in tools]
        if json_mode and (self.base_url, self.model, "response_format") not in _UNSUPPORTED:
            kw["response_format"] = {"type": "json_object"}
        if not reasoning and (self.base_url, self.model, "reasoning_effort") not in _UNSUPPORTED:
            # A THINKING model leaves content EMPTY until it stops deliberating,
            # so a verbose thinker burns the whole budget and returns "". You
            # cannot outspend it by raising max_tokens; you turn it off.
            kw["extra_body"] = {"reasoning_effort": "none"}
        return kw

    def chat(
        self, messages, system=None, tools=None, max_tokens=1024, json_mode=False, reasoning=True
    ) -> ChatResponse:
        """tools/json_mode/reasoning are BEST-EFFORT: none is universally supported
        (OpenRouter fronts hundreds of models), so each is attempted, and a 400 is
        remembered per deployment and never paid again. Defaults preserve every
        existing caller byte for byte. A deployment that 400s on tools answers
        WITHOUT them — the caller sees no tool_calls, which is the same shape as a
        model declining to call one. It demotes; it never raises.
        """
        kw = self._optional(json_mode, reasoning, tools)
        while True:
            try:
                resp = self._client.chat.completions.create(
                    model=self.model,
                    messages=self._messages(messages, system),
                    max_tokens=max_tokens,
                    **kw,
                )
                break
            except BadRequestError:
                # Drop the most exotic param first, so a server that rejects only
                # reasoning_effort keeps its json_mode. Out of params -> a real 400.
                drop = next((k for k in ("extra_body", "response_format", "tools") if k in kw), None)
                if drop is None:
                    raise
                param = "reasoning_effort" if drop == "extra_body" else drop
                _UNSUPPORTED.add((self.base_url, self.model, param))
                _log.info("%s rejected %s; retrying without it", self.model, param)
                kw.pop(drop)

        choice = resp.choices[0]
        text = choice.message.content or ""
        finish = getattr(choice, "finish_reason", None)
        if finish == "length" and not text.strip():
            # The caller cannot tell "nothing to say" from "cut off mid-thought"
            # by looking at "" — and stop_reason is routinely dropped. Say it out
            # loud; swallowing this in silence is the bug that hid the last one.
            _log.warning(
                "%s hit max_tokens=%d with EMPTY content (reasoning_len=%d) — truncated, not silent",
                self.model,
                max_tokens,
                len(getattr(choice.message, "reasoning", None) or ""),
            )
        return ChatResponse(
            text=text,
            model=self.model,
            provider=self.provider,
            tool_calls=_neutral_tool_calls(choice.message, self.model),
            stop_reason=finish,
        )

    def stream(self, messages, system=None, tools=None, max_tokens=1024):
        # reasoning OFF: a thinking model (qwen3) streams its chain-of-thought into
        # a SEPARATE field we neither surface nor persist, leaving `content` empty
        # until it stops. An analytical system prompt then makes it burn the whole
        # budget thinking and stream nothing. Reasoning is pure cost on this path —
        # turn it off so the answer lands in content. Same per-model 400-memo
        # fallback as chat() (a server that rejects reasoning_effort streams anyway).
        self.last_usage = None  # reset so a caller never reads a prior turn's count
        kw = self._optional(json_mode=False, reasoning=False, tools=None)
        while True:
            try:
                stream = self._client.chat.completions.create(
                    model=self.model,
                    messages=self._messages(messages, system),
                    max_tokens=max_tokens,
                    stream=True,
                    # The FINAL chunk carries .usage; Ollama and OpenRouter both honor it.
                    stream_options={"include_usage": True},
                    **kw,
                )
                break
            except BadRequestError:
                drop = next((k for k in ("extra_body",) if k in kw), None)
                if drop is None:
                    raise
                _UNSUPPORTED.add((self.base_url, self.model, "reasoning_effort"))
                _log.info("%s rejected reasoning_effort on stream; retrying without", self.model)
                kw.pop(drop)
        for chunk in stream:
            # The usage chunk typically has empty choices, so read usage before the
            # choices guard — whichever chunk carries it wins; None stays if none do.
            usage = getattr(chunk, "usage", None)
            if usage is not None:
                self.last_usage = {
                    "prompt_tokens": usage.prompt_tokens,
                    "completion_tokens": usage.completion_tokens,
                }
            if not getattr(chunk, "choices", None):
                continue
            delta = chunk.choices[0].delta
            content = getattr(delta, "content", None)
            if content:
                yield content
