-- Raphael — migration 016: persist the answering provider on an assistant turn.
--
-- Idempotent. Safe twice. db/ is mounted at /docker-entrypoint-initdb.d, which
-- runs ONLY on an empty volume, so an existing pgdata volume never sees this
-- file — apply it by hand:
--   docker exec -i raphael_db psql -U raphael -d raphael < db/016_answered_provider.sql
--
-- 007 persisted answered_model + degraded so a reload shows what SSE showed, but
-- NOT which provider answered. The lifeboat is admin-configurable and not
-- local-only (it can resolve to anthropic/openai_compat), so a reloaded degraded
-- banner that assumed "local" mislabels a non-local lifeboat answer. Persist the
-- provider too so the reload banner names the real one. NULL on every existing
-- row (and on user turns), which the storedDegraded fallback already tolerates.
ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS answered_provider text;
