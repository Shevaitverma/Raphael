"""Provider-neutral contracts shared by every adapter.

Two protocols (ChatProvider, EmbeddingProvider) and a Capabilities dataclass.
Nothing here imports a vendor SDK, so it stays cheap and side-effect free.
"""
from __future__ import annotations
from dataclasses import dataclass, field, asdict
from typing import Any, Iterator, Optional, Protocol, runtime_checkable


@dataclass
class Capabilities:
    """What the MODEL can do — never what the provider brochure claims.

    Every default is the CONSERVATIVE floor, so a field someone forgets to set
    can only ever under-promise. The asymmetry is the whole point: an optimistic
    wrong answer costs the TURN (a 400 mid-stream on openai_compat, or SILENT
    truncation on Ollama — worse, because it never errors and the user just gets
    a dumber answer). A conservative wrong answer costs only quality.

    `source` is how a reader tells a fact from a guess:
      "discovered" — the server told us (/api/tags, /api/v1/models)
      "static"     — a hardcoded table in this repo
      "default"    — nobody told us anything; this is the floor
    """

    max_context_tokens: int = 8192
    native_tools: bool = False
    streaming: bool = True
    json_schema: bool = False
    vision: bool = False
    model_id: str = ""
    source: str = "default"

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
