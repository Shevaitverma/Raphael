-- Raphael — migration 009: a middle task status for the Kanban board.
--
-- Idempotent. Safe twice. Apply by hand to a live volume:
--   docker exec -i raphael_db psql -U raphael -d raphael < db/009_task_status_kanban.sql
--
-- The board is three columns: To Do (open) / In Progress (in_progress) / Done
-- (done). 'open' is reused as To Do so existing rows need no data migration; the
-- only change is widening the CHECK to admit 'in_progress'.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
    CHECK (status IN ('open', 'in_progress', 'done'));
