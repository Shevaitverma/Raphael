-- Raphael — migration 015: users.last_active for the admin "Users" list.
--
-- Idempotent. Safe twice. db/ is mounted at /docker-entrypoint-initdb.d, which
-- runs ONLY on an empty volume, so an existing pgdata volume never sees this
-- file — apply it by hand:
--   docker exec -i raphael_db psql -U raphael -d raphael < db/015_last_active.sql
--
-- last_active: nullable timestamptz, STAMPED by the gateway on activity
-- (throttled), NOT by this migration. The unified admin users list reads it to
-- show "active 2h ago" / "just now". Nullable = "never seen active yet".
--
-- Additive only. No backfill, no DROP/TRUNCATE, no down. Never touches a row.

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active timestamptz;
