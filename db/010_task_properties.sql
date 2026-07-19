-- Raphael — migration 010: task priority + manual board order.
--
-- Idempotent. Safe twice. db/ is mounted at /docker-entrypoint-initdb.d, which
-- runs ONLY on an empty volume, so an existing pgdata volume never sees this
-- file — apply it by hand:
--   docker exec -i raphael_db psql -U raphael -d raphael < db/010_task_properties.sql
--
-- Two Notion-style card properties:
--  * priority — a select, default 'none' so existing rows need no data migration.
--  * position — a float for cheap manual reorder within a column. Fractional
--    indexing: to drop a card between two neighbours, store the average of their
--    positions; you only touch the moved row, never renumber the column. Seed
--    from created_at epoch so today's order (oldest first) is preserved.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'none';
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_priority_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_priority_check
    CHECK (priority IN ('none', 'low', 'medium', 'high'));

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS position double precision;
-- Backfill existing rows once (new rows get their default below); NULL means
-- "never positioned", so only those are seeded — running twice is a no-op.
UPDATE tasks SET position = extract(epoch FROM created_at) WHERE position IS NULL;
ALTER TABLE tasks ALTER COLUMN position SET DEFAULT extract(epoch FROM now());
ALTER TABLE tasks ALTER COLUMN position SET NOT NULL;

-- The board reads a column as "my tasks in this status, in board order". Widen
-- the existing index to serve ORDER BY position without a sort.
CREATE INDEX IF NOT EXISTS tasks_user_pos_idx ON tasks (user_id, status, position);
