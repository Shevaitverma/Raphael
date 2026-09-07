"""Postgres access for the mail worker. Raw SQL over psycopg, same as memory/.

Every query is scoped by user_id. Reads never raise into the worker loop — a
database hiccup must pause the pipeline, not kill the thread — but WRITES do
raise, because silently failing to record a classification would make the worker
reclassify the same message forever.

The tables are agent-svc's own (like facts/memories/user_portraits). The one
exception is `notifications`, which belongs to user-svc: alerts are POSTed to its
internal API rather than inserted here, so the outbox keeps a single writer per
service boundary.
"""
from __future__ import annotations

import logging

import psycopg
from psycopg.rows import dict_row

from config import DATABASE_URL

_log = logging.getLogger(__name__)

CONNECT_TIMEOUT = 5

# Schema defaults, returned when a user has no mail_config row yet, so the
# settings UI always renders something. Mirrors db/019_mail.sql.
CONFIG_DEFAULTS = {
    "enabled": False,
    "backfill_days": 90,
    "poll_seconds": 300,
    "label_prefix": "Assistant",
    "alerts_enabled": True,
    "quiet_start": "22:00",
    "quiet_end": "07:00",
    "telegram_chat_id": None,
    "history_id": None,
    "backfill_cursor": None,
    "backfill_done_at": None,
    "last_synced_at": None,
    "last_error": None,
}


def _conn():
    return psycopg.connect(DATABASE_URL, connect_timeout=CONNECT_TIMEOUT, row_factory=dict_row)


# --------------------------------------------------------------------------
# config

def get_config(user_id: str) -> dict:
    """Config for one user, filled with schema defaults when the row is absent."""
    out = dict(CONFIG_DEFAULTS)
    try:
        with _conn() as conn:
            row = conn.execute(
                """SELECT enabled, backfill_days, poll_seconds, label_prefix,
                          alerts_enabled, quiet_start, quiet_end, telegram_chat_id,
                          history_id, backfill_cursor, backfill_done_at,
                          last_synced_at, last_error
                     FROM mail_config WHERE user_id = %s""", (user_id,)).fetchone()
            if row:
                out.update(row)
    except Exception as e:
        _log.warning("mail get_config failed: %s", type(e).__name__)
    return out


def put_config(user_id: str, **fields) -> None:
    """Partial update. COALESCE means an unsupplied field keeps its value, so a
    settings form that posts one checkbox does not blank the rest."""
    allowed = ("enabled", "backfill_days", "poll_seconds", "label_prefix",
               "alerts_enabled", "quiet_start", "quiet_end", "telegram_chat_id")
    sets, vals = [], []
    for k in allowed:
        if k in fields:
            sets.append(f"{k} = COALESCE(%s, mail_config.{k})")
            vals.append(fields[k])
    with _conn() as conn:
        if not sets:
            conn.execute("INSERT INTO mail_config (user_id) VALUES (%s) "
                         "ON CONFLICT (user_id) DO NOTHING", (user_id,))
            return
        conn.execute(
            f"""INSERT INTO mail_config (user_id) VALUES (%s)
                ON CONFLICT (user_id) DO UPDATE SET {', '.join(sets)}""",
            (user_id, *vals))


def set_sync_state(user_id: str, **fields) -> None:
    """Cursor bookkeeping: history_id, backfill_cursor, backfill_done_at,
    last_synced_at, last_error. Written after each successful step so a crash
    resumes rather than restarts."""
    allowed = ("history_id", "backfill_cursor", "backfill_done_at",
               "last_synced_at", "last_error")
    sets = [f"{k} = %s" for k in allowed if k in fields]
    vals = [fields[k] for k in allowed if k in fields]
    if not sets:
        return
    with _conn() as conn:
        conn.execute("INSERT INTO mail_config (user_id) VALUES (%s) "
                     "ON CONFLICT (user_id) DO NOTHING", (user_id,))
        conn.execute(f"UPDATE mail_config SET {', '.join(sets)} WHERE user_id = %s",
                     (*vals, user_id))


def enabled_users() -> list[str]:
    """Users who have switched mail on. The worker's outer loop."""
    try:
        with _conn() as conn:
            rows = conn.execute(
                "SELECT user_id FROM mail_config WHERE enabled = true").fetchall()
            return [str(r["user_id"]) for r in rows]
    except Exception as e:
        # Includes "relation does not exist" before db/019 is applied. Same
        # posture as fitness_coach.go: the capability degrades, nothing crashes.
        _log.warning("mail enabled_users failed: %s", type(e).__name__)
        return []


# --------------------------------------------------------------------------
# messages

def enqueue(user_id: str, gmail_ids: list[str], is_backfill: bool) -> int:
    """Record discovered message ids as pending. Returns how many were NEW.

    ON CONFLICT DO NOTHING against the (user_id, gmail_message_id) unique
    constraint is the idempotency guarantee: re-running a history page, or
    replaying a backfill page after a crash, inserts nothing the second time.
    """
    if not gmail_ids:
        return 0
    with _conn() as conn:
        cur = conn.cursor()
        cur.executemany(
            """INSERT INTO mail_messages
                   (user_id, gmail_message_id, gmail_thread_id, received_at, is_backfill)
               VALUES (%s, %s, '', now(), %s)
               ON CONFLICT ON CONSTRAINT mail_messages_gmail_unique DO NOTHING""",
            [(user_id, mid, is_backfill) for mid in gmail_ids])
        return cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0


def claim_pending(user_id: str, limit: int) -> list[dict]:
    """Claim up to `limit` unprocessed messages.

    FOR UPDATE SKIP LOCKED, exactly as user-svc's fireDue does: two workers (or
    a restarted one racing its own previous run) never process the same row.
    Oldest first so a backfill drains in a predictable order.
    """
    with _conn() as conn:
        rows = conn.execute(
            """SELECT id, gmail_message_id, is_backfill, attempts
                 FROM mail_messages
                WHERE user_id = %s AND state IN ('pending', 'fetched')
                  AND attempts < 3
                ORDER BY received_at ASC
                LIMIT %s
                FOR UPDATE SKIP LOCKED""", (user_id, limit)).fetchall()
        return [dict(r) for r in rows]


def save_parsed(row_id: str, mail, state: str = "classified") -> None:
    """Persist the header-derived facts. NO BODY — see db/019_mail.sql."""
    with _conn() as conn:
        conn.execute(
            """UPDATE mail_messages SET
                   gmail_thread_id = %s, references_root = %s,
                   sender_address = %s, sender_display = %s,
                   subject = %s, snippet = %s, received_at = %s,
                   body_hash = %s, auth_ok = %s, bulk = %s,
                   stripped_hidden_chars = %s, state = %s, updated_at = now()
                 WHERE id = %s""",
            (mail.gmail_thread_id, mail.references_root, mail.sender_address,
             mail.sender_display, mail.subject, mail.snippet, mail.received_at,
             mail.body_hash, mail.auth_ok, mail.bulk, mail.stripped_hidden_chars,
             state, row_id))


def mark(row_id: str, state: str, error: str | None = None) -> None:
    """Advance the state machine. `attempts` only increments on failure, so a
    message that succeeds on retry does not carry a penalty forward."""
    with _conn() as conn:
        if state == "failed":
            conn.execute(
                """UPDATE mail_messages
                      SET state = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE state END,
                          attempts = attempts + 1, last_error = %s, updated_at = now()
                    WHERE id = %s""", ((error or "")[:500], row_id))
        else:
            conn.execute(
                "UPDATE mail_messages SET state = %s, last_error = NULL, updated_at = now() "
                "WHERE id = %s", (state, row_id))


def cached_classification(user_id: str, body_hash: str) -> dict | None:
    """A previous verdict for an identical template.

    Newsletters and receipts are generated from templates, so normalising away
    digits and links collapses them to one hash. Reuses the classification and
    skips the model entirely.
    """
    if not body_hash:
        return None
    try:
        with _conn() as conn:
            return conn.execute(
                """SELECT c.category, c.event_type, c.urgency, c.action_required,
                          c.counterparty, c.summary, c.reason, c.deadline,
                          c.amount_minor, c.currency
                     FROM mail_classifications c
                     JOIN mail_messages m ON m.id = c.message_id
                    WHERE m.user_id = %s AND m.body_hash = %s AND c.source <> 'cache'
                    ORDER BY c.created_at DESC LIMIT 1""",
                (user_id, body_hash)).fetchone()
    except Exception:
        return None


def save_classification(message_id: str, user_id: str, rec: dict, decision,
                        source: str, provider: str, model: str) -> None:
    """One live classification per message; a re-run overwrites it."""
    with _conn() as conn:
        conn.execute(
            """INSERT INTO mail_classifications
                   (message_id, user_id, category, event_type, urgency,
                    action_required, counterparty, summary, reason, deadline,
                    amount_minor, currency, tier, rule_fired, source, provider,
                    model, degraded)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT ON CONSTRAINT mail_classifications_message_unique
               DO UPDATE SET
                   category = EXCLUDED.category, event_type = EXCLUDED.event_type,
                   urgency = EXCLUDED.urgency, action_required = EXCLUDED.action_required,
                   counterparty = EXCLUDED.counterparty, summary = EXCLUDED.summary,
                   reason = EXCLUDED.reason, deadline = EXCLUDED.deadline,
                   amount_minor = EXCLUDED.amount_minor, currency = EXCLUDED.currency,
                   tier = EXCLUDED.tier, rule_fired = EXCLUDED.rule_fired,
                   source = EXCLUDED.source, provider = EXCLUDED.provider,
                   model = EXCLUDED.model, degraded = EXCLUDED.degraded""",
            (message_id, user_id, rec.get("category") or "other",
             rec.get("event_type") or "other", rec.get("urgency") or "none",
             bool(rec.get("action_required")), rec.get("counterparty") or "",
             rec.get("summary") or "", rec.get("reason") or "", rec.get("deadline"),
             rec.get("amount_minor"), rec.get("currency"), decision.tier,
             decision.rule_fired, source, provider, model,
             bool(rec.get("degraded"))))


# --------------------------------------------------------------------------
# sender trust + rules

def sender_history(user_id: str, address: str) -> int:
    """How many messages we have already seen from this address. Feeds the
    `frequent` trust signal — cheap, and unforgeable by the sender."""
    if not address:
        return 0
    try:
        with _conn() as conn:
            row = conn.execute(
                "SELECT count(*) AS n FROM mail_messages "
                "WHERE user_id = %s AND sender_address = %s", (user_id, address)).fetchone()
            return int(row["n"]) if row else 0
    except Exception:
        return 0


def user_rules(user_id: str) -> list[dict]:
    try:
        with _conn() as conn:
            return [dict(r) for r in conn.execute(
                """SELECT match_type, match_value, force_category, force_tier,
                          never_alert, always_alert
                     FROM mail_sender_rules WHERE user_id = %s""", (user_id,)).fetchall()]
    except Exception:
        return []


# --------------------------------------------------------------------------
# label id cache

def get_labels(user_id: str) -> dict[str, str]:
    try:
        with _conn() as conn:
            return {r["name"]: r["gmail_label_id"] for r in conn.execute(
                "SELECT name, gmail_label_id FROM mail_labels WHERE user_id = %s",
                (user_id,)).fetchall()}
    except Exception:
        return {}


def put_label(user_id: str, name: str, label_id: str) -> None:
    with _conn() as conn:
        conn.execute(
            """INSERT INTO mail_labels (user_id, name, gmail_label_id) VALUES (%s,%s,%s)
               ON CONFLICT (user_id, name) DO UPDATE SET gmail_label_id = EXCLUDED.gmail_label_id""",
            (user_id, name, label_id))


# --------------------------------------------------------------------------
# read models for the UI

def list_classified(user_id: str, tier: str | None = None, limit: int = 50) -> list[dict]:
    where = "WHERE m.user_id = %s"
    params: list = [user_id]
    if tier:
        where += " AND c.tier = %s"
        params.append(tier)
    params.append(min(limit, 200))
    try:
        with _conn() as conn:
            return [dict(r) for r in conn.execute(
                f"""SELECT m.id, m.gmail_message_id, m.gmail_thread_id, m.sender_address,
                           m.sender_display, m.subject, m.received_at, m.state,
                           m.stripped_hidden_chars, m.auth_ok, m.bulk,
                           c.category, c.event_type, c.tier, c.summary, c.reason,
                           c.deadline, c.amount_minor, c.currency, c.degraded,
                           c.corrected_tier, c.corrected_category, c.rule_fired
                      FROM mail_messages m
                      LEFT JOIN mail_classifications c ON c.message_id = m.id
                      {where}
                      ORDER BY m.received_at DESC LIMIT %s""", params).fetchall()]
    except Exception as e:
        _log.warning("mail list_classified failed: %s", type(e).__name__)
        return []


def stats(user_id: str) -> dict:
    try:
        with _conn() as conn:
            rows = conn.execute(
                """SELECT c.tier, count(*) AS n FROM mail_classifications c
                    WHERE c.user_id = %s GROUP BY c.tier""", (user_id,)).fetchall()
            states = conn.execute(
                """SELECT state, count(*) AS n FROM mail_messages
                    WHERE user_id = %s GROUP BY state""", (user_id,)).fetchall()
            return {"tiers": {r["tier"]: r["n"] for r in rows},
                    "states": {r["state"]: r["n"] for r in states}}
    except Exception:
        return {"tiers": {}, "states": {}}


def record_correction(user_id: str, message_id: str, tier: str | None,
                      category: str | None) -> bool:
    """The V2 corpus. Stored beside the original verdict, never overwriting it —
    the pair (what we said, what you said) is the training signal."""
    with _conn() as conn:
        cur = conn.execute(
            """UPDATE mail_classifications
                  SET corrected_tier = COALESCE(%s, corrected_tier),
                      corrected_category = COALESCE(%s, corrected_category),
                      corrected_at = now()
                WHERE user_id = %s AND message_id = %s""",
            (tier, category, user_id, message_id))
        return cur.rowcount > 0
