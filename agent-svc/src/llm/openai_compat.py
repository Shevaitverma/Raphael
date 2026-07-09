"""OpenAI-compatible chat via the `openai` SDK with a base_url.

Serves BOTH Ollama (http://localhost:11434/v1) and OpenRouter. Streaming uses
chat.completions with stream=True.

capabilities(): qwen2.5:7b -> native_tools True; gemma3:12b / llama2 ->
native_tools False.
"""
from __future__ import annotations

from openai import OpenAI

from llm.base import Capabilities, ChatResponse


def _native_tools_for(model: str) -> bool:
    m = (model or "").lower()
    # qwen2.5:7b does native tool calling; gemma3:12b and llama2 do not.
    return "qwen2.5" in m


class OpenAICompatProvider:
    def __init__(self, base_url, api_key, model, backend="ollama"):
        self.model = model
        self.backend = backend  # "ollama" | "openrouter"
        # provider name follows the credential kind, not the wire protocol.
        self.provider = "local" if backend == "ollama" else "openai_compat"
        # Ollama ignores the key but the SDK requires a non-empty string.
        self._client = OpenAI(base_url=base_url, api_key=api_key or "ollama")

    def capabilities(self) -> Capabilities:
        return Capabilities(
            max_context_tokens=32768,
            native_tools=_native_tools_for(self.model),
            streaming=True,
            json_schema=True,
        )

    def _messages(self, messages, system) -> list:
        out = []
        if system:
            out.append({"role": "system", "content": system})
        for m in messages:
            out.append({"role": m["role"], "content": m["content"]})
        return out

    def chat(self, messages, system=None, tools=None, max_tokens=1024) -> ChatResponse:
        resp = self._client.chat.completions.create(
            model=self.model,
            messages=self._messages(messages, system),
            max_tokens=max_tokens,
        )
        choice = resp.choices[0]
        return ChatResponse(
            text=choice.message.content or "",
            model=self.model,
            provider=self.provider,
            tool_calls=[],
            stop_reason=getattr(choice, "finish_reason", None),
        )

    def stream(self, messages, system=None, tools=None, max_tokens=1024):
        stream = self._client.chat.completions.create(
            model=self.model,
            messages=self._messages(messages, system),
            max_tokens=max_tokens,
            stream=True,
        )
        for chunk in stream:
            if not getattr(chunk, "choices", None):
                continue
            delta = chunk.choices[0].delta
            content = getattr(delta, "content", None)
            if content:
                yield content
