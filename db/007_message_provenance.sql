-- Raphael — migration 007: per-message answer provenance.
--
-- Idempotent. Safe twice. db/ is mounted at /docker-entrypoint-initdb.d, which
-- runs ONLY on an empty volume, so an existing pgdata volume never sees this
-- file — apply it by hand:
--   docker exec -i raphael_db psql -U raphael -d raphael < db/007_message_provenance.sql
--
-- Two facts about an assistant turn were emitted live over SSE and then lost on
-- reload: which model produced it, and whether the lifeboat degraded it. The
-- degraded banner is a product requirement, not decoration — persisting it makes
-- it survive a reload instead of silently looking like a normal answer. Both
-- columns are NULL/false on every existing row (user messages stay NULL), so the
-- constant defaults backfill for free.
ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS answered_model text,
    ADD COLUMN IF NOT EXISTS degraded boolean NOT NULL DEFAULT false;
