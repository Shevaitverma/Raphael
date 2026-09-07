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
    MAIL_ALLOW_CLOUD_CLASSIFIER,
    OLLAMA_BASE_URL,
    OPENROUTER_BASE_URL,
    SYSTEM_CONFIG_UID,
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


# Provider/model config is ADMIN-OWNED and SYSTEM-WIDE: every user resolves the
# system owner's credentials, not their own. The passed user_id is ignored here
# (kept in the signature so callers stay untouched). Only calendar (google_token)
# remains per-user. The credential table, one-active index, is_lifeboat flag, and
# build_provider() mapping are unchanged — portability and lifeboat semantics hold.
def _fetch_active(user_id: str):
    return _get(f"/internal/users/{SYSTEM_CONFIG_UID}/credential/active")


def _fetch_lifeboat(user_id: str):
    return _get(f"/internal/users/{SYSTEM_CONFIG_UID}/credential/lifeboat")


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


def classifier(user_id: str):
    """The credential for MAIL classification: a LOCAL provider, or None.

    Deliberately NOT extractor(). extractor falls back to the lifeboat, and the
    lifeboat is by design a cloud provider (it exists to keep chat alive when a
    paid credential dies). Email bodies are the most private data this system
    touches, so "the local model is down" must mean "do not classify", never
    "send it to OpenRouter instead".

    MAIL_ALLOW_CLOUD_CLASSIFIER is the one way past that, and it is an explicit
    operator decision recorded in config, not a runtime fallback the system can
    take on its own. Even then it uses the ACTIVE credential — never the
    lifeboat, whose whole job is to be reached by accident.

    None -> the worker runs rules-only (tier 4) and says so, which is a real
    degraded mode, not a silent one.
    """
    cred = _fetch_active(user_id)
    if cred and cred.get("provider") == "local":
        return build_provider(cred)
    if cred and MAIL_ALLOW_CLOUD_CLASSIFIER:
        return build_provider(cred)
    return None


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
