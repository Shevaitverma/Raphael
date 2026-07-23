-- Raphael — migration 017: fitness (workouts + body metrics).
--
-- Idempotent. Safe twice. db/ is mounted at /docker-entrypoint-initdb.d, which
-- runs ONLY on an empty volume, so an existing pgdata volume never sees this
-- file — apply it by hand:
--   docker exec -i raphael_db psql -U raphael -d raphael < db/017_fitness.sql
--
-- Per-user application data, no secrets — lives in user-svc alongside tasks and
-- reminders, reached through the same JWT-uid-forcing gateway proxy. Two doors:
-- a chat log-workout tool and a Fitness UI form -> REST. Both land on the same
-- user_id-scoped rows.
-- Additive only. No DROP/TRUNCATE, no down. Never deletes a row.

-- (a) workouts: one logged session. category is a free text bucket (strength /
-- cardio / …) defaulted so a bare "log a run" still stores. duration/calories/
-- distance are all optional — a strength set has no distance, a walk has no
-- reps — so they are nullable. performed_on is a date (the day it happened),
-- defaulted to today when the client omits it.
CREATE TABLE IF NOT EXISTS workouts (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category     text NOT NULL DEFAULT 'strength',
    title        text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
    duration_min int,
    calories     int,
    distance_km  double precision,
    notes        text,
    performed_on date NOT NULL DEFAULT (now()::date),
    created_at   timestamptz NOT NULL DEFAULT now()
);
-- The list/stats query: "my workouts, most recent day first".
CREATE INDEX IF NOT EXISTS workouts_user_date_idx ON workouts (user_id, performed_on DESC);

-- (b) body_metrics: a single measurement (weight, body_fat, resting_hr, …).
-- metric_type is free text so new measurements need no migration; value is the
-- number, unit its label ('kg', '%', 'bpm'). recorded_on is the day, defaulted
-- to today.
CREATE TABLE IF NOT EXISTS body_metrics (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    metric_type text NOT NULL,
    value       double precision NOT NULL,
    unit        text,
    notes       text,
    recorded_on date NOT NULL DEFAULT (now()::date),
    created_at  timestamptz NOT NULL DEFAULT now()
);
-- The per-type history query (e.g. latest weight) + the typed list.
CREATE INDEX IF NOT EXISTS body_metrics_user_type_idx ON body_metrics (user_id, metric_type, recorded_on DESC);
