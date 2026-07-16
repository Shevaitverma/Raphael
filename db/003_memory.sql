-- Raphael — migration 003: episodic memories + a fact triple store.
--
-- HOW THIS GETS APPLIED
--
-- docker-compose mounts db/ at /docker-entrypoint-initdb.d, which Postgres runs
-- ONLY on an empty data volume. An existing pgdata volume will NEVER see this
-- file. On any live database it is applied by hand:
--
--     docker exec -i raphael_db psql -U raphael -d raphael < db/003_memory.sql
--
-- Every statement below is idempotent: applying it twice is a no-op.
--
-- WHAT CHANGES
--
-- memories gains a lifecycle. A 'raw' row is a verbatim turn — it duplicates the
-- messages table and earns nothing. An 'episodic' row is a distilled event with a
-- confidence and a decay signal. valid_until is the tombstone: NULL = live,
-- set = archived. Nothing is deleted; a memory that was true last March is a fact
-- about last March, not garbage.
--
-- facts is a separate triple store because a triple has a shape a blob does not:
-- (subject, predicate, object) dedups. The UNIQUE constraint on the normalized
-- columns IS the dedup mechanism.

-- ------------------------------------------------------------- memories ----

-- kind: land it as 'raw' so the constant default backfills all existing rows for
-- free (PG11+ keeps it in the catalog — no table rewrite), THEN flip the default
-- for new writers. Existing rows really are raw; that is not a migration
-- artifact, it is what they are.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'raw';
ALTER TABLE memories ALTER COLUMN kind SET DEFAULT 'episodic';

ALTER TABLE memories ADD COLUMN IF NOT EXISTS confidence real NOT NULL DEFAULT 0.5;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS times_seen integer NOT NULL DEFAULT 1;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS valid_until timestamptz;

-- last_seen deliberately lands WITHOUT a default. `DEFAULT now()` would stamp a
-- two-year-old row as seen today and make the recency term score it as fresh —
-- that is not a shortcut, it is false data. Backfill from created_at, which is
-- the only honest answer, and only then make it NOT NULL / DEFAULT now().
ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_seen timestamptz;
UPDATE memories SET last_seen = created_at WHERE last_seen IS NULL;
ALTER TABLE memories ALTER COLUMN last_seen SET NOT NULL;
ALTER TABLE memories ALTER COLUMN last_seen SET DEFAULT now();

-- ON DELETE SET NULL, never CASCADE: a memory must outlive the transcript it was
-- learned from. Deleting a conversation forgets the conversation, not the person.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS source_message_id uuid
    REFERENCES messages(id) ON DELETE SET NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memories_kind_check') THEN
        ALTER TABLE memories ADD CONSTRAINT memories_kind_check
            CHECK (kind IN ('raw', 'episodic'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memories_confidence_check') THEN
        ALTER TABLE memories ADD CONSTRAINT memories_confidence_check
            CHECK (confidence > 0 AND confidence <= 1);
    END IF;
END $$;

-- Archive the legacy raw rows. Two reasons, both sufficient on their own:
--   1. They duplicate messages. Retrieval over them returns the transcript.
--   2. Their vectors were embedded WITHOUT the 'search_document: ' prefix that
--      nomic-embed-text requires. Prefixed and unprefixed vectors in one HNSW
--      index do not error — they silently crater recall. Archiving them means
--      every LIVE row is prefixed, so the prefix change costs no backfill script.
UPDATE memories SET valid_until = now() WHERE kind = 'raw' AND valid_until IS NULL;

-- The HNSW index must be PARTIAL. HNSW walks ef_search candidates and applies
-- the valid_until filter AFTERWARDS, so once archived rows dominate the graph a
-- top-5 query quietly returns 2 live rows and no error. Restricting the index to
-- live rows means the walk can only ever land on live rows.
DROP INDEX IF EXISTS memories_embedding_idx;
CREATE INDEX IF NOT EXISTS memories_embedding_idx
    ON memories USING hnsw (embedding vector_cosine_ops)
    WHERE valid_until IS NULL;

-- Lexical half of hybrid retrieval. An expression index: no stored tsvector
-- column, no trigger to keep in sync, nothing to drift.
CREATE INDEX IF NOT EXISTS memories_content_fts_idx
    ON memories USING gin (to_tsvector('english', content));

-- ---------------------------------------------------------------- facts ----
-- The length CHECKs do two jobs at once: they keep (user_id + three normalized
-- texts) under the ~2704-byte btree index-tuple limit even at worst-case 3-byte
-- UTF-8, and they cap a model that decides to hallucinate a paragraph into an
-- object slot.
CREATE TABLE IF NOT EXISTS facts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    subject     text NOT NULL CHECK (length(subject)   BETWEEN 1 AND 120),
    predicate   text NOT NULL CHECK (length(predicate) BETWEEN 1 AND 80),
    object      text NOT NULL CHECK (length(object)    BETWEEN 1 AND 300),

    -- The DATABASE normalizes, and the writer cannot bypass it. The UNIQUE
    -- constraint below is the entire dedup mechanism; making it depend on every
    -- future writer remembering to call a _norm() helper is how you get
    -- "Sheva_likes_coffee" and "sheva likes coffee" as two facts.
    subject_n   text GENERATED ALWAYS AS
        (lower(btrim(regexp_replace(replace(subject,   '_', ' '), '\s+', ' ', 'g')))) STORED,
    predicate_n text GENERATED ALWAYS AS
        (lower(btrim(regexp_replace(replace(predicate, '_', ' '), '\s+', ' ', 'g')))) STORED,
    object_n    text GENERATED ALWAYS AS
        (lower(btrim(regexp_replace(replace(object,    '_', ' '), '\s+', ' ', 'g')))) STORED,

    confidence  real    NOT NULL DEFAULT 0.7 CHECK (confidence > 0 AND confidence <= 1),
    times_seen  integer NOT NULL DEFAULT 1,
    first_seen  timestamptz NOT NULL DEFAULT now(),
    last_seen   timestamptz NOT NULL DEFAULT now(),

    embedding       vector(768) NOT NULL,
    embedding_model text NOT NULL,

    source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,

    -- Re-hearing a fact is an UPDATE (times_seen + 1), not a second row.
    CONSTRAINT facts_triple_unique UNIQUE (user_id, subject_n, predicate_n, object_n)
);

-- No facts_user_idx: facts_triple_unique's leading column is already user_id,
-- so a user_id-only scan uses that btree. A second index would be dead weight.
CREATE INDEX IF NOT EXISTS facts_embedding_idx
    ON facts USING hnsw (embedding vector_cosine_ops);
