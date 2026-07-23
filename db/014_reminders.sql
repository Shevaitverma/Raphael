-- Raphael — migration 014: reminders (recurring) + in-app notifications feed.
--
-- Idempotent. Safe twice. db/ is mounted at /docker-entrypoint-initdb.d, which
-- runs ONLY on an empty volume, so an existing pgdata volume never sees this
-- file — apply it by hand:
--   docker exec -i raphael_db psql -U raphael -d raphael < db/014_reminders.sql
--
-- Per-user application data, no secrets — lives in user-svc alongside tasks,
-- reached through the same JWT-uid-forcing gateway proxy. Two doors: a chat
-- create_reminder tool COMPILES NL->schedule ONCE at authoring, and a Reminders
-- UI form -> REST. Runtime firing is LLM-free: a user-svc time.Ticker goroutine
-- polls next_fire, claims with FOR UPDATE SKIP LOCKED, writes a notification
-- (the sink), advances next_fire FROM THE FIRE TIME.
-- Additive only. No DROP/TRUNCATE, no down. Never deletes a row.

-- (a) IANA timezone on users (e.g. 'Asia/Kolkata'). Web auto-detects + saves it;
-- cron is evaluated in this tz and FORCE-STAMPED onto each reminder (never the
-- LLM). NOT NULL DEFAULT 'UTC' so existing rows stay valid until the web reports
-- the real zone.
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'UTC';

-- (b) reminders. kind='cron' uses cron (5-field) evaluated in timezone, optionally
-- bounded by until; kind='once' uses fire_at. next_fire is the single poll key,
-- precomputed at authoring and advanced FROM THE FIRE TIME (no drift). next_fire
-- goes NULL + active=false once a once fires or a cron's next slot passes until.
-- No unique ::date index — timestamptz->date is not immutable; the claim layer
-- (FOR UPDATE SKIP LOCKED + advancing next_fire in the tx) dedups instead.
CREATE TABLE IF NOT EXISTS reminders (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind          text NOT NULL CHECK (kind IN ('once', 'cron')),
    cron          text,                          -- 5-field cron, when kind='cron'
    fire_at       timestamptz,                   -- the moment, when kind='once'
    until         timestamptz,                   -- optional bound (closes "today only")
    timezone      text NOT NULL,                 -- IANA, force-stamped from users.timezone
    next_fire     timestamptz,                   -- poll key; NULL once deactivated
    active        boolean NOT NULL DEFAULT true,
    text          text NOT NULL CHECK (char_length(btrim(text)) BETWEEN 1 AND 500),
    last_fired_at timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);
-- The poll: "active reminders due now" (WHERE active AND next_fire<=now()). Partial
-- index over the live rows only — deactivated onces / past-until crons (active=false,
-- next_fire NULL) drop out of the index entirely.
CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders (next_fire) WHERE active;

-- (c) notifications: the in-app feed = the delivery sink. Firing writes one row
-- here; delivery is decoupled from firing so WhatsApp/push can be added as
-- adapters later. reminder_id is nullable + ON DELETE SET NULL so deleting a
-- reminder keeps its already-delivered notifications (history survives).
CREATE TABLE IF NOT EXISTS notifications (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reminder_id uuid REFERENCES reminders(id) ON DELETE SET NULL,
    text        text NOT NULL CHECK (char_length(btrim(text)) BETWEEN 1 AND 500),
    created_at  timestamptz NOT NULL DEFAULT now(),
    read_at     timestamptz                      -- NULL = unread
);
-- The feed query: "my notifications" + the bell's unread poll. read_at in the
-- index lets both the unread lookup and the mark-read list share one btree.
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, read_at);
