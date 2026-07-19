"""Provider resolution and the dead-credential test.

chat(user_id) reads the ONE active credential from user-svc
/internal/users/{uid}/credential/active and maps it:
  anthropic+api_key -> anthropic_api
  anthropic+oauth   -> anthropic_cli
  openai_compat     -> openai_compat(OpenRouter)
  local             -> openai_compat(Ollama)
No active row -> NoActiveCredential (HTTP 409).

embed()        -> always the local encoder (never a chat provider).
lifeboat(uid)  -> the user's designated is_lifeboat row, excluding the active
                  one (local Ollama on a laptop, OpenRouter in the cloud), or None.

Selection has no precedence: the user picks, we read their one active row. The
lifeboat is an error path, not a preference ordering.
"""
from __future__ import annotations

import httpx

from config import (
    ANTHROPIC_DEFAULT_MODEL,
    INTERNAL_TOKEN,
    OLLAMA_BASE_URL,
    OPENROUTER_BASE_URL,
    USER_SVC_URL,
)
from llm.anthropic_api import AnthropicAPIProvider
from llm.anthropic_cli import AnthropicCLIProvider
from llm.openai_compat import OpenAICompatProvider


class NoActiveCredential(Exception):
    """No active credential row for the user -> surfaces as HTTP 409."""


def _get(path: str):
    headers = {"X-Internal-Token": INTERNAL_TOKEN} if INTERNAL_TOKEN else {}
    r = httpx.get(USER_SVC_URL + path, headers=headers, timeout=10.0)
    if r.status_code in (204, 404):
        return None
    r.raise_for_status()
    data = r.json()
    return data or None


def google_token(user_id: str) -> str | None:
    """The user's Google OAuth access token from user-svc, or None if they have
    not connected Calendar (404) or anything at all went wrong. Never raises:
    a token lookup problem must degrade the calendar tool, not break the turn."""
    try:
        data = _get(f"/internal/users/{user_id}/google/token")
    except Exception:
        return None
    return (data or {}).get("access_token") or None


def _fetch_active(user_id: str):
    return _get(f"/internal/users/{user_id}/credential/active")


def _fetch_lifeboat(user_id: str):
    return _get(f"/internal/users/{user_id}/credential/lifeboat")


def build_provider(cred: dict):
    provider = cred["provider"]
    auth = cred.get("auth_type")
    model = cred.get("model_id")
    key = cred.get("api_key")
    base = cred.get("base_url")

    if provider == "anthropic" and auth == "api_key":
        return AnthropicAPIProvider(api_key=key, model=model or ANTHROPIC_DEFAULT_MODEL)
    if provider == "anthropic" and auth == "oauth":
        return AnthropicCLIProvider(oauth_token=key, model=model or ANTHROPIC_DEFAULT_MODEL)
    if provider == "openai_compat":
        return OpenAICompatProvider(
            base_url=base or OPENROUTER_BASE_URL, api_key=key, model=model, backend="openrouter"
        )
    if provider == "local":
        return OpenAICompatProvider(
            base_url=base or OLLAMA_BASE_URL, api_key=key or "ollama", model=model, backend="ollama"
        )
    raise ValueError(f"unknown provider mapping: {provider}/{auth}")


def chat(user_id: str):
    cred = _fetch_active(user_id)
    if not cred:
        raise NoActiveCredential(
            "No active credential. Add a model provider key to use the assistant."
        )
    return build_provider(cred)


def lifeboat(user_id: str):
    cred = _fetch_lifeboat(user_id)
    if not cred:
        return None
    return build_provider(cred)


def extractor(user_id: str):
    """The credential for BACKGROUND extraction: active if it is local, else the
    lifeboat, else None.

    NEVER the user's paid credential. Extraction is work the user did not ask
    for, and billing it to their chat key silently doubles their spend on every
    turn. embeddings.py:8-11 already made this exact ruling for embeddings —
    extraction is the same category. None -> no extraction -> store nothing.
    """
    cred = _fetch_active(user_id)
    if cred and cred.get("provider") == "local":
        return build_provider(cred)
    return lifeboat(user_id)


def embed():
    """Always the in-process encoder. Never a chat provider."""
    from llm.embeddings import get_encoder

    return get_encoder()


def is_dead_credential(exc: BaseException) -> bool:
    """Fire the lifeboat ONLY on a permanently-dead credential:
      401 authentication_error, 403 permission_error (incl. billing_error), 402.
    NEVER on 429 rate limit, 5xx, timeout, or connection error — those are
    transient faults of the provider, not the credential, and must propagate to
    the client as an SSE 'error' event.
    """
    import anthropic
    import openai

    if isinstance(
        exc,
        (
            anthropic.AuthenticationError,
            anthropic.PermissionDeniedError,
            openai.AuthenticationError,
            openai.PermissionDeniedError,
        ),
    ):
        return True
    # 402 Payment Required surfaces as a generic APIStatusError with a code.
    if getattr(exc, "status_code", None) == 402:
        return True
    return False
