-- Raphael — migration 011: access-driven reinforcement for facts + memories.
--
-- Idempotent. Safe twice. db/ is mounted at /docker-entrypoint-initdb.d, which
-- runs ONLY on an empty volume, so an existing pgdata volume never sees this
-- file — apply it by hand:
--   docker exec -i raphael_db psql -U raphael -d raphael < db/011_memory_reinforcement.sql
--
-- THE HUMAN-MEMORY PATTERN. On recall, the retriever reinforces the rows it
-- actually returned — a pure SQL bump, zero tokens, no LLM call. Used memory
-- earns rank (access + recency) and earns durability (the reaper shields
-- recently-accessed rows from archival). Two new columns on each store:
--
--  * access_count  — how many times recall SURFACED this row. Distinct from
--    times_seen, which counts re-HEARINGS (the same triple asserted again).
--    Being retrieved is not being re-told; conflating them would let a fact the
--    user never repeats look freshly asserted. Separate counter, separate meaning.
--  * last_accessed — when recall last surfaced it. Seeded from last_seen so an
--    existing row reads as "last used when last heard", never as never-used
--    (NULL). The reaper and the recency term both key on this.
--
-- Additive only. Nothing is dropped or rewritten.

-- ---------------------------------------------------------------- facts ----
ALTER TABLE facts ADD COLUMN IF NOT EXISTS access_count integer NOT NULL DEFAULT 0;

-- Lands WITHOUT a default so existing rows are seeded from real data, not now().
-- Stamping every old row "accessed today" would make the recency term score it
-- as fresh — false data. Backfill from last_seen (the honest last-touch time),
-- then leave it nullable: a brand-new row that has never been recalled is
-- legitimately NULL until its first reinforcement.
ALTER TABLE facts ADD COLUMN IF NOT EXISTS last_accessed timestamptz;
UPDATE facts SET last_accessed = last_seen WHERE last_accessed IS NULL;

-- ------------------------------------------------------------- memories ----
ALTER TABLE memories ADD COLUMN IF NOT EXISTS access_count integer NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_accessed timestamptz;
UPDATE memories SET last_accessed = last_seen WHERE last_accessed IS NULL;

-- Recall ranks a user's live memories by reinforcement (access_count DESC,
-- last_accessed DESC); the reaper reads the same order to spare hot rows.
-- Partial on the live set — archived rows are never ranked or reinforced.
CREATE INDEX IF NOT EXISTS memories_user_access_idx
    ON memories (user_id, access_count DESC, last_accessed DESC)
    WHERE valid_until IS NULL;

-- facts has no tombstone; every row is live. facts_triple_unique already leads
-- with user_id, so per-user scans hit that btree — this index adds the
-- reinforcement ordering on top of it.
CREATE INDEX IF NOT EXISTS facts_user_access_idx
    ON facts (user_id, access_count DESC, last_accessed DESC);
