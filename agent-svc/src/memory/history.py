"""Short-term memory: read the conversation back from conv-svc.

The defect this fixes is the worst one in the product. workflow.py:117 builds
`messages = [{"role": "user", "content": state["message"]}]` — the current
message and nothing else. Every turn is persisted to conv-svc and never read
back, so "what did I just say?" fails on a product whose entire job is to
remember.

Best-effort by contract: conv-svc being slow or down degrades the answer, it
does not break the turn. ANY failure returns ([], []) and the model answers
with no history, exactly as it does today.
"""
from __future__ import annotations

import httpx

from config import CONV_SVC_URL
from memory.budget import est_tokens

# conv-svc caps ?limit= at 500 (conv-svc/handlers.go:307).
_MAX_LIMIT = 500
# The critical path, BEFORE the first token — not the 10.0s at workflow.py:133,
# which is a persist AFTER the answer already streamed. A slow conv-svc must not
# buy the user ten seconds of dead air.
_TIMEOUT = 3.0


def normalize(msgs: list[dict]) -> list[dict]:
    """DB rows -> [{"role","content"}] a provider will actually accept.

    DB roles are user|assistant|tool; Anthropic accepts only user/assistant,
    wants to open on user, and is happiest alternating. So: drop tool turns and
    empty content (a failed turn can persist an empty assistant row), never open
    on an assistant turn, and collapse same-role runs — persist_node returns
    early on failure (workflow.py:129,135), so history CAN hold two consecutive
    user messages, and some providers reject that outright.
    """
    out: list[dict] = []
    for m in msgs:
        # Another service's JSON: assume nothing about the shape.
        if not isinstance(m, dict):
            continue
        role, content = m.get("role"), m.get("content")
        if role not in ("user", "assistant"):
            continue
        if not isinstance(content, str) or not content.strip():
            continue
        # Never open on an assistant turn.
        if not out and role == "assistant":
            continue
        if out and out[-1]["role"] == role:
            # Collapse, don't drop: the run is two real things the user said.
            out[-1]["content"] += "\n\n" + content
            continue
        out.append({"role": role, "content": content})
    return out


def fetch(conversation_id: str, budget_tokens: int, user_id: str) -> tuple[list[dict], list[dict]]:
    """(kept, dropped) — each [{"role","content"}], oldest-first.

    kept is the most recent history that fits budget_tokens; dropped is the
    older remainder (a summarizer's input, if we ever want one). Never raises.

    NOTE: user_id is not optional. conv-svc requires ?user_id= and 404s on a
    mismatch (ownership landed in 0c7293f), so there is no URL to build without
    it. See the report — the frozen signature omitted it while its own docstring
    named it; a default would make every fetch a silent 404 -> empty history,
    i.e. the exact defect this module exists to fix, shipped invisibly.
    """
    # Over-fetch bound: a message that could fit in the budget costs at least a
    # few tokens, so asking for more rows than this is guaranteed waste. The
    # precise trim happens below, on tokens, not on rows.
    # ponytail: assumes ~8-token messages; the local trim is what's authoritative.
    limit = min(_MAX_LIMIT, max(4, budget_tokens // 8))
    try:
        r = httpx.get(
            f"{CONV_SVC_URL}/conversations/{conversation_id}/messages",
            params={"user_id": user_id, "limit": limit},
            timeout=_TIMEOUT,
        )
        if r.status_code >= 300:
            return [], []
        data = r.json()
        # Trust boundary: this is another service's output. It is documented as a
        # BARE ARRAY (conv-svc/handlers.go:201) — an object here means the
        # contract moved, and .get() on a list raises into the turn.
        if not isinstance(data, list):
            return [], []
    except Exception:
        # Timeout, connection refused, malformed JSON: answer without history.
        return [], []

    msgs = normalize(data)

    # Trim from the OLDEST end: recency is what the defect needs. "What did I
    # just say?" is answered by the last turn, never by the first.
    tail: list[dict] = []
    used = 0
    for m in reversed(msgs):
        cost = est_tokens(m["content"])
        if used + cost > budget_tokens:
            break
        tail.append(m)
        used += cost

    # Re-normalize AFTER the slice: trimming can strand a leading assistant turn.
    # msgs is already normalized, so this can only strip that stranded turn —
    # it can never collapse — which is what makes the arithmetic below exact.
    kept = normalize(list(reversed(tail)))
    return kept, msgs[: len(msgs) - len(kept)]
