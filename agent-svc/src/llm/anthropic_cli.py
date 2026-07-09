"""Claude via the OAuth / claude-agent-sdk CLI door — OUT OF SCOPE.

Why this exists but is empty: a subscription CLAUDE_CODE_OAUTH_TOKEN only gets
full model access through the claude-agent-sdk / CLI door (raw Messages-API
calls with that token are throttled — Opus/Sonnet return 429, only Haiku slips
through). Wiring that door in means shipping the `claude` CLI binary plus Node
in the image and running as a non-root user, and it yields a completion-only,
degraded tool path. Per docs/CONTRACT.md and plan.md Phase 4 the walking
skeleton defines this adapter and raises. The resolver maps anthropic+oauth
here so the shape is real even though the body is not.
"""
from __future__ import annotations

from llm.base import Capabilities


class AnthropicCLIProvider:
    provider = "anthropic"

    def __init__(self, oauth_token=None, model="claude-opus-4-8"):
        self.model = model
        self._oauth_token = oauth_token

    def capabilities(self) -> Capabilities:
        # Completion-only, no native tools (the OAuth path is already degraded).
        return Capabilities(
            max_context_tokens=200_000,
            native_tools=False,
            streaming=True,
            json_schema=False,
        )

    def chat(self, *args, **kwargs):
        raise NotImplementedError("oauth adapter: out of scope for the walking skeleton")

    def stream(self, *args, **kwargs):
        raise NotImplementedError("oauth adapter: out of scope for the walking skeleton")
