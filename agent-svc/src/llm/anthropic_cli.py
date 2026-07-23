"""Claude via the OAuth / claude-agent-sdk CLI door.

A Claude Code subscription token (CLAUDE_CODE_OAUTH_TOKEN) only gets full model
access through the claude-agent-sdk / CLI door. Raw Messages-API calls with that
token are throttled — Opus/Sonnet return 429, only Haiku slips through — so this
adapter drives the SDK's query() as a COMPLETION: one turn, tools disabled.

That yields no native tool_use blocks, so capabilities().native_tools is False
and the graph falls back to prompt-and-parse JSON. This is the degraded Claude
path, by design (plan.md: "if we ever have to cut scope, cut oauth").

Multi-user safety: the token is handed to the CLI subprocess via
ClaudeAgentOptions(env=...), NEVER written into os.environ. A process-global
token — the norm in single-tenant assistants — would let one user's request run
under another user's credential. This is the one rule that makes an OAuth path
safe in a multi-user service.

Deployment: needs the `claude` CLI binary + Node in the image. The slim
production agent-svc image OMITS claude-agent-sdk (see Dockerfile vs
Dockerfile.oauth). The import is lazy, so this module loads fine without the
package; only a request that actually selects anthropic+oauth raises a clear
OAuthAdapterUnavailable.
"""
from __future__ import annotations

import asyncio
import queue
import threading
from typing import Iterator, Optional

from llm.base import Capabilities, ChatResponse

_SENTINEL = object()


class OAuthAdapterUnavailable(RuntimeError):
    """claude-agent-sdk (and the `claude` CLI) are not present in this image."""


def _load_sdk():
    try:
        from claude_agent_sdk import (  # type: ignore
            AssistantMessage,
            ClaudeAgentOptions,
            TextBlock,
            query,
        )
    except ImportError as e:  # pragma: no cover - depends on image variant
        raise OAuthAdapterUnavailable(
            "anthropic+oauth was selected but claude-agent-sdk is not installed. "
            "This is expected in the slim production image. Use an api_key "
            "credential, or deploy the oauth-capable image (Dockerfile.oauth)."
        ) from e
    return query, ClaudeAgentOptions, AssistantMessage, TextBlock


class AnthropicCLIProvider:
    provider = "anthropic"

    def __init__(self, oauth_token: Optional[str] = None, model: str = "claude-opus-4-8"):
        self.model = model
        self._oauth_token = oauth_token

    def capabilities(self) -> Capabilities:
        # Completion-only: the CLI door returns no tool_use blocks, so the graph
        # must prompt-and-parse rather than rely on native tool calling.
        return Capabilities(
            max_context_tokens=200_000,
            native_tools=False,
            streaming=True,
            json_schema=False,
        )

    def _options(self, system):
        _, ClaudeAgentOptions, _, _ = _load_sdk()
        env = {}
        if self._oauth_token:
            # Per-call subprocess env. NEVER os.environ — see module docstring.
            env["CLAUDE_CODE_OAUTH_TOKEN"] = self._oauth_token
        return ClaudeAgentOptions(
            model=self.model,
            max_turns=1,          # completion, not an agent loop
            allowed_tools=[],     # no tools on this path
            system_prompt=system or None,
            env=env,
            setting_sources=[],   # don't inherit local project/user CLI settings
        )

    def _prompt(self, messages, system) -> str:
        # Flatten the neutral history into a single prompt turn. There are no
        # native tools here, so tool/assistant turns fold in as plain text.
        parts = []
        for m in messages:
            role = m.get("role", "user")
            content = m.get("content", "") or ""
            parts.append(content if role == "user" else f"{role}: {content}")
        return "\n\n".join(parts)

    def _run_async_to_queue(self, prompt, system, q: "queue.Queue"):
        async def run():
            query, _, AssistantMessage, TextBlock = _load_sdk()
            try:
                async for msg in query(prompt=prompt, options=self._options(system)):
                    if isinstance(msg, AssistantMessage):
                        for block in msg.content:
                            if isinstance(block, TextBlock) and block.text:
                                q.put(block.text)
            except Exception as e:  # surface to the sync consumer
                q.put(e)
            finally:
                q.put(_SENTINEL)

        # Own event loop on this worker thread — safe even if the caller is async.
        asyncio.run(run())

    def stream(self, messages, system=None, tools=None, max_tokens=1024) -> Iterator[str]:
        # Bridge the SDK's async generator to a sync one via a queue + thread.
        # Granularity is per-message (each AssistantMessage's text), coarser than
        # token-level — acceptable for the degraded OAuth path.
        prompt = self._prompt(messages, system)
        q: "queue.Queue" = queue.Queue()
        t = threading.Thread(
            target=self._run_async_to_queue, args=(prompt, system, q), daemon=True
        )
        t.start()
        while True:
            item = q.get()
            if item is _SENTINEL:
                break
            if isinstance(item, Exception):
                raise item
            yield item
        t.join(timeout=1)

    def chat(self, messages, system=None, tools=None, max_tokens=1024, reasoning=True) -> ChatResponse:
        # reasoning accepted for a uniform signature but ignored (the CLI backend
        # has no thinking toggle).
        # Reuse the thread bridge so we never call asyncio.run inside a running
        # event loop.
        text = "".join(
            self.stream(messages, system=system, tools=tools, max_tokens=max_tokens)
        )
        return ChatResponse(
            text=text,
            model=self.model,
            provider=self.provider,
            tool_calls=[],
            stop_reason="end_turn",
        )
