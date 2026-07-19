-- Raphael — migration 004: per-user customizable assistant name.
--
-- Idempotent. Safe twice. db/ is mounted at /docker-entrypoint-initdb.d, which
-- runs ONLY on an empty volume, so an existing pgdata volume never sees this
-- file — apply it by hand:
--   docker exec -i raphael_db psql -U raphael -d raphael < db/004_assistant_name.sql
--
-- The name goes into the assistant's system prompt (agent-svc build_system), so
-- the length CHECK is also a defence: 40 chars is a name, not a paragraph of
-- injected instructions. The constant DEFAULT backfills every existing row in
-- the catalog with no table rewrite — every current user keeps 'Raphael'.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS assistant_name text NOT NULL DEFAULT 'Raphael';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_assistant_name_len') THEN
    ALTER TABLE users ADD CONSTRAINT users_assistant_name_len
      CHECK (char_length(btrim(assistant_name)) BETWEEN 1 AND 40);
  END IF;
END $$;
