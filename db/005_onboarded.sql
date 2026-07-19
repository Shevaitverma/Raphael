-- Raphael — migration 005: onboarding flag.
--
-- Idempotent. Safe twice. db/ is mounted at /docker-entrypoint-initdb.d, which
-- runs ONLY on an empty volume, so an existing pgdata volume never sees this
-- file — apply it by hand:
--   docker exec -i raphael_db psql -U raphael -d raphael < db/005_onboarded.sql
--
-- Gates the one-time "name your assistant" screen. false = show it, true = skip.
-- New users get the DEFAULT false (dev-login upserts a row with the default) and
-- see the screen once. EXISTING rows predate the feature, so they are backfilled
-- to true — a returning user who already chose (or kept) 'Raphael' is not nagged.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS onboarded boolean NOT NULL DEFAULT false;

-- One-time backfill: mark every row that existed before this migration as
-- onboarded. Runs once; on a second apply the DEFAULT already covers new rows so
-- there is nothing pre-existing to flip (this UPDATE just re-sets true=true).
UPDATE users SET onboarded = true WHERE onboarded = false;
