"""Context budgets, as fractions of the ACTIVE model's window.

The window is a property of the MODEL, not the provider, and it is passed in
per request (capabilities().max_context_tokens) — never read at boot.

There is deliberately NO flat cap here. A flat cap is exactly the bug in
retriever.py:28 today: `min(max_context_tokens // 4, 4000)` means a 1M-token
Claude window and a 32k window get an identical 4000-token budget, so paying
for a bigger model silently buys nothing. The ceiling here (24k) is a fraction
of the window until the window is enormous, and it exists so a huge remote
window does not dump 300k tokens of history into a turn that then costs a
fortune to answer.
"""
from __future__ import annotations

# A third of the window for everything we inject; the rest is the user's
# message, the answer, and headroom.
_MAX_TOTAL = 24_000
# Floor: below this the injected context is noise anyway, but a model with a
# tiny window still deserves *some* history — that is the whole defect.
_MIN_TOTAL = 384


def budgets(window: int) -> tuple[int, int, int]:
    """(profile, memories, history) TOKEN budgets for a window of `window` tokens.

    Splits 0.15 / 0.25 / 0.60 — history is the biggest share because history is
    what the model cannot reconstruct from anywhere else.
    """
    total = max(_MIN_TOTAL, min(int(window) // 3, _MAX_TOTAL))
    return int(total * 0.15), int(total * 0.25), int(total * 0.60)


def est_tokens(s: str) -> int:
    # ponytail: ~4 chars/token, the English average. It is an ESTIMATE — it runs
    # on the critical path before the first token, and a real tokenizer per
    # provider is a dependency and a round-trip we are not paying for. It skews
    # low on code and CJK, which is why the budget is a third of the window and
    # not the whole thing. Upgrade path: tiktoken/provider count_tokens if we
    # ever see truncation in practice.
    return max(1, len(s) // 4)
