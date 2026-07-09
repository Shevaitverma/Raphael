"""Provider-neutral contracts shared by every adapter.

Two protocols (ChatProvider, EmbeddingProvider) and a Capabilities dataclass.
Nothing here imports a vendor SDK, so it stays cheap and side-effect free.
"""
from __future__ import annotations
from dataclasses import dataclass, field, asdict
from typing import Any, Iterator, Optional, Protocol, runtime_checkable


@dataclass
class Capabilities:
    max_context_tokens: int
    native_tools: bool
    streaming: bool
    json_schema: bool

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ChatResponse:
    """A neutral, vendor-free chat result. No provider tool-call ids, no
    thinking blocks, no cache markers — adapters strip all of that."""

    text: str
    model: str
    provider: str
    tool_calls: list = field(default_factory=list)  # [{"name": .., "arguments": {..}}]
    stop_reason: Optional[str] = None


@runtime_checkable
class ChatProvider(Protocol):
    provider: str
    model: str

    def chat(self, messages, system=None, tools=None, max_tokens=1024) -> ChatResponse: ...

    def stream(self, messages, system=None, tools=None, max_tokens=1024) -> Iterator[str]: ...

    def capabilities(self) -> Capabilities: ...


@runtime_checkable
class EmbeddingProvider(Protocol):
    model_name: str

    def embed(self, texts) -> list: ...
