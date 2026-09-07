"""The mail worker: a daemon thread that syncs, classifies, labels and alerts.

Shaped like main.py's existing _reaper_loop — a thread, not a framework. There
is no broker: `mail_messages.state` plus FOR UPDATE SKIP LOCKED is the queue,
exactly as user-svc's fireDue uses `reminders.next_fire`.

ONE TICK:
  1. bootstrap the sync cursor if this user has never synced
  2. advance the backfill by one page, if one is still running
  3. pull new message ids from users.history.list
  4. process a bounded batch: fetch -> parse -> classify -> decide -> label -> alert
  5. stamp last_synced_at (or last_error, honestly)

EVERY STEP COMMITS SEPARATELY, so a crash resumes where it stopped rather than
restarting. The backfill in particular is a multi-hour job on a real mailbox and
must survive a restart without re-reading 10,000 messages.

ALERTS ARE SUPPRESSED FOR BACKFILL ROWS, permanently. Importing three months of
history is not a reason to send three months of notifications.

The worker never inserts into `notifications` directly. That table belongs to
user-svc, so alerts are POSTed to its internal API — one writer per service
boundary, and user-svc's delivery ticker picks them up from there.
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timedelta, timezone

import httpx

from config import (
    INTERNAL_TOKEN,
    MAIL_BACKFILL_DAYS,
    MAIL_BATCH_SIZE,
    MAIL_ENABLED,
    MAIL_LABEL_PREFIX,
    MAIL_POLL_SECONDS,
    USER_SVC_URL,
)
from llm import resolver
from mail import classify, gmail, labels, parse, rules, store

_log = logging.getLogger(__name__)

# Gmail labels that mean "not really in the mailbox". Chats and drafts cannot be
# labelled at all, and spam/trash are not the user's problem.
SKIP_LABELS = frozenset({"DRAFT", "CHAT", "TRASH", "SPAM"})

# An act-now alert older than this is worse than no alert: a "meeting in 20
# minutes" delivered after a three-hour outage is noise wearing urgency.
ALERT_TTL = timedelta(hours=2)

# Schema enforcement is probed once per (provider, model), not per email.
_probed: dict[tuple, bool] = {}


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------

def _post_alert(user_id: str, text: str, tier: str, dedup_key: str | None,
                link: str | None) -> bool:
    """Hand one alert to user-svc's outbox. Never raises."""
    expires = (_now() + ALERT_TTL).isoformat() if tier == "act_now" else None
    try:
        r = httpx.post(
            f"{USER_SVC_URL}/internal/users/{user_id}/notifications",
            headers={"X-Internal-Token": INTERNAL_TOKEN},
            json={"text": text[:500], "tier": tier, "dedup_key": dedup_key,
                  "link_url": link, "expires_at": expires},
            timeout=10.0,
        )
        # 409 = the dedup key already exists. That is the system working, not a
        # failure: the same thread already alerted at this tier.
        return r.status_code in (200, 201, 204, 409)
    except Exception as e:
        _log.warning("mail alert post failed: %s", type(e).__name__)
        return False


def alert_text(mail, rec: dict, decision) -> str:
    """The notification body. Templated, LLM-FREE — same discipline as
    fitness_coach.go's messages.

    Built from validated fields, never from raw email text: `summary` is already
    length-capped and stripped by the classifier, and the sender display name is
    the only other attacker-chosen string that appears. Under 500 chars because
    notifications.text has a CHECK.
    """
    icon = {"act_now": "🔴", "act_soon": "🟡"}.get(decision.tier, "🔵")
    who = (mail.sender_display or mail.sender_address or "unknown")[:60]
    head = f"{icon} {rec.get('summary') or mail.subject or 'New mail'}"
    bits = [f"From: {who}"]
    amt, cur = rec.get("amount_minor"), rec.get("currency")
    if amt is not None:
        bits.append(f"Amount: {cur or ''} {amt / 100:,.2f}".strip())
    if rec.get("deadline"):
        bits.append(f"Due: {rec['deadline']}")
    if rec.get("reason"):
        bits.append(rec["reason"][:160])
    return (head + "\n" + "\n".join(bits))[:500]


def _thread_link(mail) -> str:
    return f"https://mail.google.com/mail/u/0/#inbox/{mail.gmail_thread_id}"


# --------------------------------------------------------------------------

def _prefilter(mail) -> dict | None:
    """The free classification. No tokens, no model.

    Bulk headers resolve a large fraction of a real inbox, and doing it here
    rather than in the prompt is the single biggest performance lever available:
    an email that never reaches the model costs nothing at all.
    """
    if mail.bulk:
        return {"category": "marketing", "event_type": "newsletter", "urgency": "none",
                "action_required": False, "counterparty": mail.sender_display,
                "summary": (mail.subject or "Bulk mail")[:200],
                "reason": "Bulk mail headers (List-Unsubscribe or Precedence).",
                "deadline": None, "amount_minor": None, "currency": None}
    return None


def _trust(user_id: str, mail) -> rules.SenderTrust:
    """Sender trust from headers and our own history. Never from the model, and
    never from anything inside the body."""
    seen = store.sender_history(user_id, mail.sender_address)
    return rules.SenderTrust(
        auth_ok=mail.auth_ok,
        bulk=mail.bulk,
        known=seen > 0,
        frequent=seen >= 3,
    )


def _schema_ok(provider) -> bool:
    """Probe grammar enforcement once per model, then remember.

    Catches the silent failures: Ollama's MLX runner dropping schemas, and
    llama.cpp failing open on a grammar parse error (logs, returns 200,
    generates unconstrained).
    """
    key = (getattr(provider, "base_url", ""), getattr(provider, "model", ""))
    if key not in _probed:
        _probed[key] = classify.supports_schema(provider) and classify.probe_enforcement(provider)
        _log.info("mail classifier schema enforcement: %s (%s)", _probed[key], key[1])
    return _probed[key]


def process_batch(user_id: str, token: str, provider, cfg: dict) -> int:
    """Fetch, classify, decide, label and alert one bounded batch.

    Returns how many messages advanced. Grouping the Gmail writes by label set is
    what lets one batchModify cover the whole batch instead of one call each.
    """
    claimed = store.claim_pending(user_id, MAIL_BATCH_SIZE)
    if not claimed:
        return 0

    prefix = cfg.get("label_prefix") or MAIL_LABEL_PREFIX
    user_rules = [rules.UserRule(**r) for r in store.user_rules(user_id)]
    schema_ok = _schema_ok(provider) if provider is not None else False

    groups: dict[tuple, list[str]] = {}
    pending_alerts: list[tuple] = []
    done = 0

    for row in claimed:
        row_id, gid = str(row["id"]), row["gmail_message_id"]
        try:
            raw = gmail.get_message(token, gid)
            if raw is None:
                # Normal: deleted or moved between the history record and now.
                store.mark(row_id, "skipped")
                continue

            mail = parse.parse_message(raw)
            if SKIP_LABELS & set(mail.label_ids):
                store.save_parsed(row_id, mail, state="skipped")
                continue

            # 1) free rules, 2) template cache, 3) the model
            rec, source = _prefilter(mail), "rules"
            if rec is None:
                cached = store.cached_classification(user_id, mail.body_hash)
                if cached:
                    rec, source = dict(cached), "cache"
            if rec is None and provider is not None:
                rec, source = classify.classify(provider, mail, schema_ok), "llm"

            needs_review = rec is None
            trust = _trust(user_id, mail)
            enriched = dict(rec or {})
            enriched["sender_address"] = mail.sender_address
            decision = rules.decide(
                enriched if rec else None, trust, user_rules,
                now=_now(), dedup_anchor=mail.references_root,
            )

            store.save_parsed(row_id, mail, state="classified")
            if rec is not None:
                store.save_classification(
                    row_id, user_id, rec, decision, source,
                    getattr(provider, "provider", "") or "rules",
                    getattr(provider, "model", "") or "",
                )

            add, remove = labels.plan(decision.tier, decision.category, needs_review, prefix)
            groups.setdefault((tuple(add), tuple(remove)), []).append(gid)

            # A backfill row can never alert, however urgent it looks: it is
            # history, and the user has already lived through it.
            if decision.alert and not row["is_backfill"] and cfg.get("alerts_enabled", True):
                pending_alerts.append(
                    (alert_text(mail, rec or {}, decision), decision.tier,
                     decision.dedup_key, _thread_link(mail)))
            done += 1
        except gmail.GmailAuthError:
            raise                                    # dead grant: stop the user's tick
        except Exception as e:
            _log.warning("mail process %s failed: %s: %s", gid, type(e).__name__, e)
            store.mark(row_id, "failed", f"{type(e).__name__}: {e}")

    # Gmail writes, grouped so one call covers many messages.
    if groups:
        try:
            cache = labels.ensure(user_id, token, labels.all_names(prefix))
            labels.apply_group(token, groups, cache)
        except Exception as e:
            # Labels are set semantics, so the next tick reconciles. The
            # classification is already stored and is not lost.
            _log.warning("mail labelling failed: %s", type(e).__name__)

    for text, tier, dedup, link in pending_alerts:
        _post_alert(user_id, text, tier, dedup, link)

    return done


# --------------------------------------------------------------------------

def sync_user(user_id: str, token: str, cfg: dict) -> None:
    """Discover new message ids. Bootstrap, then backfill, then incremental."""
    history_id = cfg.get("history_id")

    if not history_id:
        # Persist the cursor BEFORE the backfill, never after: anything arriving
        # during a multi-hour import is then caught by the first incremental
        # pass instead of falling in the gap.
        profile = gmail.get_profile(token)
        history_id = str(profile.get("historyId") or "")
        if not history_id:
            raise gmail.GmailError("profile returned no historyId")
        since = _backfill_epoch(cfg)
        store.set_sync_state(user_id, history_id=history_id,
                             backfill_cursor=f"{since}|")
        cfg["backfill_cursor"] = f"{since}|"
        _log.info("mail bootstrap: history_id set, backfill queued")

    cursor = cfg.get("backfill_cursor")
    if cursor:
        # The cursor is "<epoch>|<pageToken>". The epoch is carried rather than
        # recomputed because Gmail requires the SAME q for every page of a
        # paginated search: recomputing "90 days ago" on each tick would slide
        # the window forward mid-import and silently skip the oldest messages
        # near the boundary.
        #
        # Epoch seconds, not `after:2026/05/20` and not `newer_than:3m`: Gmail
        # interprets bare dates at PST midnight, which is an off-by-one day for
        # everyone not in Pacific time.
        after, _, page = cursor.partition("|")
        q = f"after:{after}"
        ids, next_page = gmail.list_message_ids(token, q=q, page_token=page or None)
        new = store.enqueue(user_id, ids, is_backfill=True)
        if next_page:
            store.set_sync_state(user_id, backfill_cursor=f"{after}|{next_page}")
        else:
            store.set_sync_state(user_id, backfill_cursor=None, backfill_done_at=_now())
            _log.info("mail backfill complete for user")
        _log.info("mail backfill page: %d ids, %d new", len(ids), new)
        return          # one page per tick: the backfill shares the box

    try:
        ids, _, current = gmail.list_history(token, history_id)
    except gmail.HistoryTooOld:
        # The cursor aged out of Gmail's ~1 week window. Documented, expected,
        # and handled by re-bootstrapping rather than by losing mail.
        _log.warning("mail history cursor expired; re-bootstrapping")
        store.set_sync_state(user_id, history_id=None)
        return
    if ids:
        store.enqueue(user_id, ids, is_backfill=False)
    if current:
        store.set_sync_state(user_id, history_id=str(current))


def _backfill_epoch(cfg: dict) -> int:
    days = cfg.get("backfill_days") or MAIL_BACKFILL_DAYS
    return int((_now() - timedelta(days=days)).timestamp())


def tick_user(user_id: str) -> None:
    """One user's turn. Never raises — one broken mailbox must not stop others."""
    cfg = store.get_config(user_id)
    if not cfg.get("enabled"):
        return
    token = resolver.google_token(user_id)
    if not token:
        # user-svc has already raised the reconnect alert on invalid_grant; this
        # only records why the worker is idle, so the UI can say so.
        store.set_sync_state(user_id, last_error="Gmail not connected or token expired")
        return

    provider = resolver.classifier(user_id)
    if provider is None:
        # Tier 4: rules-only. Real degradation, stated out loud, and it never
        # alerts — a pipeline that cannot read cannot be trusted to interrupt.
        _log.warning("mail: no local classifier available; running rules-only")

    try:
        sync_user(user_id, token, cfg)
        n = process_batch(user_id, token, provider, cfg)
        store.set_sync_state(user_id, last_synced_at=_now(), last_error=None)
        if n:
            _log.info("mail processed %d messages", n)
    except gmail.GmailAuthError as e:
        store.set_sync_state(user_id, last_error=f"Google rejected the credential: {e}")
    except Exception as e:
        _log.warning("mail tick failed: %s: %s", type(e).__name__, e)
        store.set_sync_state(user_id, last_error=f"{type(e).__name__}: {e}")


def tick() -> int:
    users = store.enabled_users()
    for uid in users:
        try:
            tick_user(uid)
        except Exception as e:
            _log.warning("mail tick_user crashed: %s", type(e).__name__)
    return len(users)


def _loop() -> None:
    while True:
        try:
            tick()
        except Exception as e:
            _log.warning("mail loop error: %s", type(e).__name__)
        time.sleep(max(60, MAIL_POLL_SECONDS))


def start() -> bool:
    """Start the worker thread. Returns whether it started.

    ponytail: fixed-interval daemon thread, same shape as main.py's reaper. The
    per-user poll_seconds column is read but not yet honoured per user — one
    global cadence is right until there are enough mailboxes for it not to be.
    """
    if not MAIL_ENABLED:
        _log.info("mail worker disabled (MAIL_ENABLED unset)")
        return False
    threading.Thread(target=_loop, name="mail-worker", daemon=True).start()
    _log.info("mail worker started (every %ds)", max(60, MAIL_POLL_SECONDS))
    return True


def demo() -> None:
    """Self-check for the pure pieces: alert text and the prefilter."""
    from types import SimpleNamespace

    mail = SimpleNamespace(
        sender_display="CRED", sender_address="alerts@cred.club",
        subject="Payment due", gmail_thread_id="t1",
        bulk=False, auth_ok=True,
    )
    rec = {"summary": "Credit card payment due", "amount_minor": 1845000,
           "currency": "INR", "deadline": "2026-08-25", "reason": "Due date is near."}
    d = rules.Decision("act_now", True, "finance", "deadline_imminent", "<x>:act_now")
    t = alert_text(mail, rec, d)
    assert t.startswith("🔴"), t
    assert "18,450.00" in t, t              # minor units rendered as money
    assert "2026-08-25" in t and "CRED" in t
    assert len(t) <= 500

    # the DB CHECK is 500 chars; a hostile summary must not blow it
    huge = {"summary": "x" * 400, "reason": "y" * 400, "amount_minor": None,
            "currency": None, "deadline": None}
    assert len(alert_text(mail, huge, d)) <= 500

    # tier drives the icon, and only the top two tiers ever reach here
    assert alert_text(mail, rec, rules.Decision("act_soon", True, "finance", "r")).startswith("🟡")

    # bulk mail is resolved without a model
    bulk = SimpleNamespace(bulk=True, sender_display="Newsletter", subject="Sale!")
    pf = _prefilter(bulk)
    assert pf["category"] == "marketing" and pf["action_required"] is False
    assert _prefilter(SimpleNamespace(bulk=False)) is None

    assert _thread_link(mail).endswith("t1")

    # the backfill cursor must carry its epoch across pages, or a multi-hour
    # import slides its own search window forward and drops the oldest mail
    for cursor, want_after, want_page in (
        ("1755500000|", "1755500000", ""),
        ("1755500000|CAoQAQ", "1755500000", "CAoQAQ"),
    ):
        after, _, page = cursor.partition("|")
        assert after == want_after and page == want_page, cursor
    assert _backfill_epoch({"backfill_days": 90}) < int(_now().timestamp())

    print("worker.py demo: ok")


if __name__ == "__main__":
    demo()
