"""Gmail label names, ids, and what to apply to a message.

TWO ORTHOGONAL AXES, not one crossed grid:

    <prefix>/Act now | Act soon | FYI | Noise | Needs review   <- status: do what?
    Topic/Finance | Security | Work | ...                      <- category: what is it?

Crossing them would need 10 x 5 = 50 labels, all of which must be created,
applied and reconciled; keeping them independent needs 15. They also change on
different schedules — status is rewritten every time a message is reclassified,
category almost never — so a crossed label would churn for the wrong reason.

Status is MUTUALLY EXCLUSIVE, so applying one removes the other four in the same
call. Gmail's addLabelIds/removeLabelIds are SET operations, which makes that
atomic from the caller's point of view and makes every retry free.

`event_type` deliberately does NOT become a label. It is 30-odd values that would
triple the label list for something the database answers better, and Gmail search
already covers `label:Topic/Finance`.

The finer sort lives in the DB; Gmail gets the part a human scans.
"""
from __future__ import annotations

import logging

from config import MAIL_LABEL_PREFIX
from mail import gmail, store

_log = logging.getLogger(__name__)

CATEGORY_PREFIX = "Topic"

# tier -> the human-facing half of the status label
STATUS_NAMES = {
    "act_now": "Act now",
    "act_soon": "Act soon",
    "fyi": "FYI",
    "noise": "Noise",
}
NEEDS_REVIEW = "Needs review"

CATEGORY_NAMES = {
    "finance": "Finance", "security": "Security", "work": "Work", "job": "Job",
    "purchase": "Purchase", "subscription": "Subscription", "travel": "Travel",
    "personal": "Personal", "marketing": "Marketing", "other": "Other",
}


def status_label(tier: str, prefix: str = MAIL_LABEL_PREFIX) -> str:
    return f"{prefix}/{STATUS_NAMES.get(tier, 'FYI')}"


def review_label(prefix: str = MAIL_LABEL_PREFIX) -> str:
    return f"{prefix}/{NEEDS_REVIEW}"


def category_label(category: str) -> str:
    return f"{CATEGORY_PREFIX}/{CATEGORY_NAMES.get(category, 'Other')}"


def all_names(prefix: str = MAIL_LABEL_PREFIX) -> list[str]:
    """Every label this feature owns. Also the parents, so the Gmail UI renders
    the nesting instead of showing a stray top-level 'Assistant/Act now'."""
    return ([prefix, CATEGORY_PREFIX]
            + [f"{prefix}/{n}" for n in list(STATUS_NAMES.values()) + [NEEDS_REVIEW]]
            + [f"{CATEGORY_PREFIX}/{n}" for n in CATEGORY_NAMES.values()])


def plan(tier: str, category: str, needs_review: bool,
         prefix: str = MAIL_LABEL_PREFIX) -> tuple[list[str], list[str]]:
    """(add, remove) as label NAMES. Pure — the whole reason this is testable.

    Every status label the message is not getting is removed, because a
    reclassification must not leave the old status behind next to the new one.
    """
    want_status = review_label(prefix) if needs_review else status_label(tier, prefix)
    add = [want_status, category_label(category)]
    remove = [n for n in
              ([f"{prefix}/{v}" for v in STATUS_NAMES.values()] + [review_label(prefix)])
              if n != want_status]
    return add, remove


def ensure(user_id: str, token: str, names: list[str]) -> dict[str, str]:
    """name -> Gmail label id, creating what is missing.

    Three tiers of lookup so the common path costs nothing: our cache, then one
    labels.list (1 quota unit), then create (5 units each, once ever). Label ids
    are opaque and per-mailbox and are never hardcoded.
    """
    cache = store.get_labels(user_id)
    missing = [n for n in names if n not in cache]
    if not missing:
        return cache

    remote = gmail.list_labels(token)
    for name in list(missing):
        if name in remote:
            store.put_label(user_id, name, remote[name])
            cache[name] = remote[name]
            missing.remove(name)

    for name in missing:
        try:
            lid = gmail.create_label(token, name)
        except gmail.GmailError as e:
            # A racing create returns 409; re-reading is cheaper than locking.
            _log.warning("label create %r failed (%s); re-reading", name, e)
            remote = gmail.list_labels(token)
            lid = remote.get(name)
            if not lid:
                continue
        store.put_label(user_id, name, lid)
        cache[name] = lid
    return cache


def apply_group(token: str, ids_by_plan: dict, cache: dict[str, str]) -> int:
    """Apply each distinct (add, remove) label set to its group of messages.

    Grouping is what makes batchModify worth using: 50 quota units for up to
    1000 messages sharing a label set, versus 5 units each. Unknown names are
    skipped rather than failing the group — a label we could not create should
    cost one label, not the whole batch.
    """
    done = 0
    for (add_names, remove_names), message_ids in ids_by_plan.items():
        add = [cache[n] for n in add_names if n in cache]
        remove = [cache[n] for n in remove_names if n in cache]
        if not add and not remove:
            continue
        gmail.apply_labels(token, list(message_ids), add, remove)
        done += len(message_ids)
    return done


def demo() -> None:
    """Self-check for the pure part."""
    add, remove = plan("act_now", "finance", needs_review=False, prefix="Assistant")
    assert add == ["Assistant/Act now", "Topic/Finance"], add
    # every other status must be cleared, and the one we are applying must not be
    assert "Assistant/Act now" not in remove
    for other in ("Assistant/Act soon", "Assistant/FYI", "Assistant/Noise",
                  "Assistant/Needs review"):
        assert other in remove, other
    # a category label is never removed: it is stable across reclassification
    assert not any(n.startswith("Topic/") for n in remove)

    add, _ = plan("act_now", "finance", needs_review=True, prefix="Assistant")
    assert add[0] == "Assistant/Needs review", "low confidence must not claim a tier"

    # unknown values fall to the safe floor rather than inventing a label
    add, _ = plan("bogus", "cryptocurrency", needs_review=False, prefix="A")
    assert add == ["A/FYI", "Topic/Other"], add

    # the prefix is configurable, and the parents exist so nesting renders
    names = all_names("Mail")
    assert "Mail" in names and "Topic" in names
    assert len(names) == 2 + 5 + 10, len(names)
    assert all(n and "  " not in n for n in names)

    print("labels.py demo: ok")


if __name__ == "__main__":
    demo()
