-- Raphael — migration 019: mail intelligence (Gmail sync + local classification
-- + the notification outbox).
--
-- Idempotent, additive. Safe twice. db/ is mounted at /docker-entrypoint-initdb.d,
-- which runs ONLY on an empty volume, so an existing pgdata volume never sees this
-- file — apply it by hand:
--   docker exec -i raphael_db psql -U raphael -d raphael < db/019_mail.sql
--
-- No DROP/TRUNCATE, no down. The mail worker (agent-svc) log-and-continues when
-- these tables are absent, exactly as fitness_coach.go does for 018 — a missing
-- migration degrades the capability, it never crashes the service.
--
-- Two design facts the schema encodes, both load-bearing:
--
--  1. NO EMAIL BODIES ARE STORED. Only subject, Gmail's own snippet, the sender,
--     and a body hash. Gmail stays the store of record; a re-classification
--     refetches. This is the smallest blast radius available if the DB ever leaks.
--
--  2. THE MODEL'S OUTPUT IS ADVISORY. mail_classifications holds what the model
--     said (category/urgency/…); `tier` holds what the deterministic rules engine
--     DECIDED after capping on sender trust. auth_ok/bulk live on mail_messages
--     because they come from headers, never from the model — an email that fails
--     SPF/DKIM/DMARC can never be escalated no matter what it persuaded the model
--     to emit.
--
-- Enum discipline follows the house rule: CHECK the values that are structural and
-- stable (category, tier, urgency, state), leave `event_type` free text validated
-- in Python — it is a ~24-value taxonomy that will churn, and a CHECK would make
-- every taxonomy tweak a migration.

-- ---------------------------------------------------------------------------
-- (a) mail_config: one row per user — the worker's settings and sync cursors.
-- Same shape as fitness_config: enabled defaults false (capability off until the
-- human opts in), and the store returns SCHEMA DEFAULTS when no row exists so the
-- settings UI always renders.
--
-- history_id is the Gmail incremental-sync cursor. backfill_cursor is the
-- messages.list pageToken; NULL + backfill_done_at set = the 3-month import
-- finished. Both are text, not bigint: Gmail historyIds are opaque, increase
-- non-contiguously, and must never be treated as arithmetic.
CREATE TABLE IF NOT EXISTS mail_config (
    user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled          boolean NOT NULL DEFAULT false,
    backfill_days    int     NOT NULL DEFAULT 90,
    poll_seconds     int     NOT NULL DEFAULT 300,
    label_prefix     text    NOT NULL DEFAULT 'Assistant',
    alerts_enabled   boolean NOT NULL DEFAULT true,
    quiet_start      text    NOT NULL DEFAULT '22:00',   -- HH:MM in users.timezone
    quiet_end        text    NOT NULL DEFAULT '07:00',
    digest_times     jsonb   NOT NULL DEFAULT '["09:00","18:00"]',
    telegram_chat_id text,                               -- NULL = no telegram for this user
    history_id       text,                               -- Gmail sync cursor
    backfill_cursor  text,                               -- pageToken; NULL = not running
    backfill_done_at timestamptz,
    last_synced_at   timestamptz,
    last_error       text,                               -- last honest failure, shown in the UI
    created_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- (b) mail_messages: one row per Gmail message, ever. This IS the idempotency
-- key — UNIQUE (user_id, gmail_message_id) is what makes the whole pipeline safe
-- to re-run, and what turns a duplicated history record into a no-op insert.
--
-- state is the processing state machine:
--   pending -> fetched -> classified -> labelled
--   pending/fetched -> skipped   (draft, spam, or 404 on get — all normal)
--   any -> failed                (attempts > 3; visible in the UI, retryable)
-- attempts + last_error ARE the dead-letter queue. No broker, no second table.
--
-- is_backfill permanently suppresses alerts for that row: importing 3 months of
-- history must never page the user 4,000 times.
--
-- stripped_hidden_chars counts the white-on-white / font-size:0 / zero-width text
-- removed during sanitisation. It is a deterministic injection indicator that no
-- amount of rephrasing evades — a message carrying kilobytes of invisible text is
-- higher signal than any classifier.
CREATE TABLE IF NOT EXISTS mail_messages (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    gmail_message_id      text NOT NULL,
    gmail_thread_id       text NOT NULL,
    references_root       text,                    -- RFC5322 References/In-Reply-To root
    sender_address        text NOT NULL DEFAULT '',
    sender_display        text NOT NULL DEFAULT '',
    subject               text NOT NULL DEFAULT '' CHECK (char_length(subject) <= 500),
    snippet               text NOT NULL DEFAULT '' CHECK (char_length(snippet) <= 500),
    received_at           timestamptz NOT NULL,    -- from internalDate
    body_hash             text,                    -- template-dedup cache key
    auth_ok               boolean NOT NULL DEFAULT false,  -- SPF+DKIM+DMARC all pass
    bulk                  boolean NOT NULL DEFAULT false,  -- List-Unsubscribe / Precedence: bulk
    stripped_hidden_chars int  NOT NULL DEFAULT 0,
    state                 text NOT NULL DEFAULT 'pending'
                            CHECK (state IN ('pending','fetched','classified',
                                             'labelled','failed','skipped')),
    attempts              int  NOT NULL DEFAULT 0,
    last_error            text,
    is_backfill           boolean NOT NULL DEFAULT false,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT mail_messages_gmail_unique UNIQUE (user_id, gmail_message_id)
);
-- The worker's claim query: "this user's unfinished messages, newest first".
CREATE INDEX IF NOT EXISTS mail_messages_work_idx
    ON mail_messages (user_id, state, received_at DESC);
-- The template cache lookup, and the sender-history count that feeds SenderTrust.
CREATE INDEX IF NOT EXISTS mail_messages_hash_idx
    ON mail_messages (user_id, body_hash) WHERE body_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS mail_messages_sender_idx
    ON mail_messages (user_id, sender_address);

-- ---------------------------------------------------------------------------
-- (c) mail_classifications: what the model said + what the rules decided.
-- UNIQUE (message_id) — one live classification per message; a re-classification
-- overwrites rather than accumulating.
--
-- amount is stored in MINOR UNITS as bigint (paise, cents), never a float: money
-- in floating point is a bug waiting, and llama.cpp only honours JSON-schema
-- min/max on integers anyway, so the model is asked for an integer too.
--
-- There is deliberately NO confidence column. Self-reported LLM confidence is
-- structured hallucination (measured: the constrained decoder emitted 95.0 for a
-- 0..1 field). Real calibrated confidence arrives with the V2 logistic-regression
-- classifier; until then `Needs review` is the honest escape hatch.
--
-- corrected_* is the user-feedback corpus. Collected from day one because it is
-- free now and it is the entire input to V2 personalisation.
CREATE TABLE IF NOT EXISTS mail_classifications (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id         uuid NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
    user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category           text NOT NULL CHECK (category IN (
                           'finance','security','work','job','purchase',
                           'subscription','travel','personal','marketing','other')),
    event_type         text NOT NULL DEFAULT 'other'
                           CHECK (char_length(event_type) BETWEEN 1 AND 40),
    urgency            text NOT NULL DEFAULT 'none'
                           CHECK (urgency IN ('now','soon','later','none')),
    action_required    boolean NOT NULL DEFAULT false,
    counterparty       text NOT NULL DEFAULT '' CHECK (char_length(counterparty) <= 80),
    summary            text NOT NULL DEFAULT '' CHECK (char_length(summary) <= 200),
    reason             text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 300),
    deadline           date,
    amount_minor       bigint,
    currency           text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
    -- what the RULES ENGINE decided, after capping the model on sender trust
    tier               text NOT NULL CHECK (tier IN ('act_now','act_soon','fyi','noise')),
    rule_fired         text,                    -- which rule matched, for "why did I get this?"
    source             text NOT NULL DEFAULT 'llm' CHECK (source IN ('llm','rules','cache')),
    provider           text NOT NULL DEFAULT '',
    model              text NOT NULL DEFAULT '',
    degraded           boolean NOT NULL DEFAULT false,  -- tier-3 path: no schema enforcement
    corrected_tier     text,
    corrected_category text,
    corrected_at       timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT mail_classifications_message_unique UNIQUE (message_id)
);
-- The UI's two list queries: by tier (the review inbox) and by category (browse).
CREATE INDEX IF NOT EXISTS mail_classifications_tier_idx
    ON mail_classifications (user_id, tier, created_at DESC);
CREATE INDEX IF NOT EXISTS mail_classifications_cat_idx
    ON mail_classifications (user_id, category, created_at DESC);
-- The V2 corpus query: "everything the human corrected".
CREATE INDEX IF NOT EXISTS mail_classifications_corrected_idx
    ON mail_classifications (user_id, corrected_at DESC) WHERE corrected_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- (d) mail_sender_rules: the human's overrides. Evaluated FIRST in the rules
-- engine — a user rule beats every heuristic, including the trust caps, because
-- the person always outranks the machine.
--
-- source='learned' marks a rule PROPOSED from repeated corrections. Proposed, not
-- auto-applied: one bad auto-rule silently suppresses a whole category forever.
CREATE TABLE IF NOT EXISTS mail_sender_rules (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    match_type     text NOT NULL CHECK (match_type IN ('address','domain','pattern')),
    match_value    text NOT NULL CHECK (char_length(btrim(match_value)) BETWEEN 1 AND 320),
    force_category text,
    force_tier     text CHECK (force_tier IS NULL OR
                               force_tier IN ('act_now','act_soon','fyi','noise')),
    never_alert    boolean NOT NULL DEFAULT false,
    always_alert   boolean NOT NULL DEFAULT false,
    hits           int  NOT NULL DEFAULT 0,
    source         text NOT NULL DEFAULT 'user' CHECK (source IN ('user','learned')),
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT mail_sender_rules_unique UNIQUE (user_id, match_type, match_value)
);

-- ---------------------------------------------------------------------------
-- (e) mail_labels: the Gmail name -> label id cache. Gmail label ids are opaque
-- and per-mailbox, so they are NEVER hardcoded: look up here, create on miss,
-- cache the id. One labels.list costs 1 quota unit; this table means we pay it
-- once rather than on every message.
CREATE TABLE IF NOT EXISTS mail_labels (
    user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name           text NOT NULL,
    gmail_label_id text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, name)
);

-- ---------------------------------------------------------------------------
-- (f) notifications becomes a real outbox.
--
-- 014 created this table and said, verbatim: "delivery is decoupled from firing
-- so WhatsApp/push can be added as adapters later." This is that later. Every
-- column added here is DEFAULTED, so reminders.go:fireDue and fitness_coach.go
-- keep working untouched — and both immediately gain Telegram delivery, because
-- the sender drains the table rather than being wired to one producer.
--
-- tier drives delivery behaviour, not importance:
--   act_now  -> Telegram with sound
--   act_soon -> Telegram silent (disable_notification)
--   fyi      -> digest only
-- (there is no 'noise' tier here: noise is never written to the outbox at all.)
--
-- delivered_at NULL = still owed. attempts/next_attempt_at are the retry cursor.
-- expires_at exists because a stale urgent alert is worse than none: an act_now
-- that missed its 2h window is dropped from the queue and rolled into the digest
-- rather than arriving in a burst after a recovery.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS tier            text NOT NULL DEFAULT 'fyi';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS dedup_key       text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS link_url        text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS channel         text NOT NULL DEFAULT 'inapp';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS delivered_at    timestamptz;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS attempts        int  NOT NULL DEFAULT 0;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS expires_at      timestamptz;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS channel_msg_id  text;

-- CHECK added separately + guarded: ALTER TABLE ... ADD CONSTRAINT has no
-- IF NOT EXISTS, so re-running this file would error without the catalog probe.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notifications_tier_check') THEN
        ALTER TABLE notifications
            ADD CONSTRAINT notifications_tier_check
            CHECK (tier IN ('act_now','act_soon','fyi'));
    END IF;
END $$;

-- The dedup guarantee: same thread + same tier can only ever produce ONE alert.
-- Partial, so the two existing producers (which write no dedup_key) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedup_idx
    ON notifications (user_id, dedup_key) WHERE dedup_key IS NOT NULL;
-- The sender's claim query: "what is owed, soonest first". Partial over undelivered
-- rows only, so the index stays small as history accumulates.
CREATE INDEX IF NOT EXISTS notifications_outbox_idx
    ON notifications (next_attempt_at) WHERE delivered_at IS NULL;
