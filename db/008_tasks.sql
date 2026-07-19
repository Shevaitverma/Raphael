-- Raphael — migration 008: per-user tasks (a simple task manager).
--
-- Idempotent. Safe twice. db/ is mounted at /docker-entrypoint-initdb.d, which
-- runs ONLY on an empty volume, so an existing pgdata volume never sees this
-- file — apply it by hand:
--   docker exec -i raphael_db psql -U raphael -d raphael < db/008_tasks.sql
--
-- Per-user application data, no secrets — lives in user-svc alongside the other
-- per-user CRUD (profile, google), reached through the same JWT-uid-forcing
-- gateway proxy. Phase 1 is manual CRUD from the Tasks view; an assistant
-- create_task tool can ride the existing tool loop later.
CREATE TABLE IF NOT EXISTS tasks (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
    notes      text NOT NULL DEFAULT '',
    status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
    due_date   date,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
-- The list query is "my tasks, open first, soonest due" — one index serves it.
CREATE INDEX IF NOT EXISTS tasks_user_idx ON tasks (user_id, status, due_date);
