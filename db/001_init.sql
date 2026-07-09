-- Raphael — initial schema.
-- Every table here is vendor-neutral. See plan.md "Provider Independence".

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ---------------------------------------------------------------- users ----
CREATE TABLE IF NOT EXISTS users (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email       text NOT NULL UNIQUE,
    name        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------- conversations ----
CREATE TABLE IF NOT EXISTS conversations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       text NOT NULL DEFAULT 'New conversation',
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_user_idx ON conversations (user_id, created_at DESC);

-- ------------------------------------------------------------- messages ----
-- content and tool_calls are VENDOR-NEUTRAL.
-- No provider tool-call ids (toolu_… / call_…). No thinking blocks.
-- No cache_control markers. Adapters translate; the wire format never lands here.
CREATE TABLE IF NOT EXISTS messages (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role             text NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
    content          text NOT NULL DEFAULT '',
    tool_calls       jsonb,           -- [{ "name": ..., "arguments": {...} }]  our shape
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, created_at);

-- ------------------------------------------------------------- memories ----
-- 768 dims is fixed by nomic-embed-text-v1.5. Changing the encoder means
-- ALTERing this column and re-embedding every row. embedding_model records
-- which encoder produced the vector so that migration is possible.
CREATE TABLE IF NOT EXISTS memories (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content          text NOT NULL,
    embedding        vector(768) NOT NULL,
    embedding_model  text NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memories_user_idx ON memories (user_id);
CREATE INDEX IF NOT EXISTS memories_embedding_idx
    ON memories USING hnsw (embedding vector_cosine_ops);

-- -------------------------------------------------- provider_credentials ----
CREATE TABLE IF NOT EXISTS provider_credentials (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider     text NOT NULL CHECK (provider IN ('anthropic', 'openai_compat', 'local')),
    auth_type    text NOT NULL CHECK (auth_type IN ('api_key', 'oauth')),
    api_key_enc  bytea,              -- AES-256-GCM. Never returned by any API.
    base_url     text,
    model_id     text NOT NULL,
    is_active    boolean NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now(),

    -- oauth is a Claude Code subscription token. It is meaningless elsewhere.
    CONSTRAINT oauth_is_anthropic_only
        CHECK (auth_type <> 'oauth' OR provider = 'anthropic'),

    -- At most one row per provider per user. The lifeboat is the user's
    -- (possibly inactive) provider='local' row.
    CONSTRAINT one_row_per_user_provider UNIQUE (user_id, provider)
);

-- Exactly one active credential per user. Selection has no precedence:
-- the user picks, the resolver reads this row.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_credential
    ON provider_credentials (user_id)
    WHERE is_active;

-- ----------------------------------------------------------------- seed ----
-- Dev user for the walking skeleton. DEV_AUTH_ENABLED mints a JWT for this id.
INSERT INTO users (id, email, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'dev@raphael.local', 'Dev User')
ON CONFLICT (email) DO NOTHING;

-- Local Ollama credential, active by default so the system runs with no keys.
-- base_url is left NULL on purpose: "local" means "the Ollama this deployment is
-- configured for", which is an env concern (OLLAMA_BASE_URL), not a stored
-- per-credential host. localhost on a laptop, http://ollama:11434/v1 in compose.
INSERT INTO provider_credentials (user_id, provider, auth_type, model_id, is_active)
VALUES ('00000000-0000-0000-0000-000000000001', 'local', 'api_key',
        'qwen2.5:7b', true)
ON CONFLICT (user_id, provider) DO NOTHING;
