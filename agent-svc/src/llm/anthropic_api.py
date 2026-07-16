"""Claude via the official `anthropic` SDK (client.messages.create / .stream).

Default model claude-opus-4-8. We send thinking={"type":"adaptive"} and
output_config={"effort":"high"}. We do NOT send temperature/top_p/top_k or
budget_tokens — current models reject them. We stream when output may be large.

The wire format never leaves this file: `neutral_from_anthropic` translates the
vendor response into a ChatResponse, dropping thinking blocks and provider
tool-call ids (toolu_...). Only {name, arguments} survives.
"""
from __future__ import annotations

import anthropic

from llm.base import Capabilities, ChatResponse


def neutral_from_anthropic(resp, model: str) -> ChatResponse:
    """wire -> canonical. Drop thinking/redacted_thinking; strip toolu_ ids."""
    texts: list[str] = []
    tool_calls: list[dict] = []
    for block in getattr(resp, "content", None) or []:
        btype = getattr(block, "type", None)
        if btype == "text":
            texts.append(getattr(block, "text", "") or "")
        elif btype == "tool_use":
            tool_calls.append(
                {"name": getattr(block, "name", None), "arguments": getattr(block, "input", {})}
            )
        # thinking / redacted_thinking / server_tool_use / anything else: dropped.
    return ChatResponse(
        text="".join(texts),
        model=model,
        provider="anthropic",
        tool_calls=tool_calls,
        stop_reason=getattr(resp, "stop_reason", None),
    )


class AnthropicAPIProvider:
    provider = "anthropic"

    def __init__(self, api_key, model="claude-opus-4-8", base_url=None):
        self.model = model
        # Per-user key passed explicitly — never fall back to a process env key
        # (see plan.md "Per-user tokens: pass the key explicitly").
        kwargs = {"api_key": api_key}
        if base_url:
            kwargs["base_url"] = base_url
        self._client = anthropic.Anthropic(**kwargs)

    def capabilities(self) -> Capabilities:
        # source="static": no Anthropic endpoint reports per-model context or
        # modalities, so this is a hardcoded claim — a guess, not a fact.
        return Capabilities(
            max_context_tokens=1_000_000,
            native_tools=True,
            streaming=True,
            # Anthropic has NO response_format. Coercion is forced tool-use, and
            # nothing here implements it. False until earned.
            json_schema=False,
            vision=True,
            model_id=self.model,
            source="static",
        )

    def _params(self, messages, system, max_tokens, tools=None) -> dict:
        params = dict(
            model=self.model,
            max_tokens=max_tokens,
            thinking={"type": "adaptive"},
            output_config={"effort": "high"},
            messages=[{"role": m["role"], "content": m["content"]} for m in messages],
        )
        if system:
            params["system"] = system
        if tools:
            # `parameters` is the neutral name for the JSON Schema; Anthropic
            # calls the same object input_schema. An ABSENT key and an empty
            # list are not the same request, so no tools means no key.
            params["tools"] = [
                {"name": t["name"], "description": t["description"], "input_schema": t["parameters"]}
                for t in tools
            ]
        return params

    def chat(self, messages, system=None, tools=None, max_tokens=1024) -> ChatResponse:
        resp = self._client.messages.create(**self._params(messages, system, max_tokens, tools))
        # Check stop_reason before reading content; handle a refusal.
        if getattr(resp, "stop_reason", None) == "refusal":
            return ChatResponse(
                text="[The model declined to respond to this request.]",
                model=self.model,
                provider="anthropic",
                tool_calls=[],
                stop_reason="refusal",
            )
        return neutral_from_anthropic(resp, self.model)

    def stream(self, messages, system=None, tools=None, max_tokens=4096):
        # text_stream yields only text deltas — thinking blocks stream empty and
        # tool_use ids never surface here, so nothing vendor-shaped escapes.
        with self._client.messages.stream(**self._params(messages, system, max_tokens)) as s:
            for text in s.text_stream:
                if text:
                    yield text
