-- Raphael — migration 012: the user-portrait card.
--
-- HOW THIS GETS APPLIED
--
-- docker-compose mounts db/ at /docker-entrypoint-initdb.d, which Postgres runs
-- ONLY on an empty data volume. An existing pgdata volume will NEVER see this
-- file. On any live database it is applied by hand:
--
--     docker exec -i raphael_db psql -U raphael -d raphael < db/012_user_portrait.sql
--
-- Every statement below is idempotent: applying it twice is a no-op. Additive
-- only — nothing is dropped or rewritten.
--
-- WHAT CHANGES
--
-- One row per user holding a synthesized 2-3 sentence persona card — identity +
-- how to talk to them — distilled from accumulated facts by the reaper on the
-- FREE extractor credential, never per turn. context_node reads it as a stored
-- string (zero per-turn tokens). It is regenerated only when the facts change:
-- fact_fingerprint is a hash of the source facts, and synthesize() skips the LLM
-- when the fingerprint is unchanged, so an idle user costs nothing.
--
-- portrait lands in the system prompt, so its length is capped at the sanitize
-- boundary (~600 chars) in memory/portrait.py — the DEFAULT '' keeps a
-- never-synthesized user readable as "no portrait yet", never NULL.

CREATE TABLE IF NOT EXISTS user_portraits (
    user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    portrait         text NOT NULL DEFAULT '',
    fact_fingerprint text,
    updated_at       timestamptz NOT NULL DEFAULT now()
);
