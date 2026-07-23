-- Raphael — migration 018: fitness v2 (rich workouts + goals + nutrition + coach config).
--
-- Idempotent, additive. Safe twice. db/ is mounted at /docker-entrypoint-initdb.d,
-- which runs ONLY on an empty volume, so an existing pgdata volume never sees this
-- file — apply it by hand:
--   docker exec -i raphael_db psql -U raphael -d raphael < db/018_fitness_v2.sql
--
-- Builds on 017 (workouts + body_metrics). No DROP/TRUNCATE, no down. All numeric
-- ranges (RPE 1..10, etc.) are validated in Go so a bad value returns 400, never a
-- CHECK-violation 500 — the DB stays permissive on those.

-- (a) workouts: richer session detail. exercises is a passed-through JSON array of
-- {name,sets,reps,weight_kg,duration_min,distance_km}. pace/HR/effort/mood/location
-- are all optional single-session fields. perceived_effort is RPE (1..10, Go-validated).
ALTER TABLE workouts ADD COLUMN IF NOT EXISTS exercises        jsonb NOT NULL DEFAULT '[]';
ALTER TABLE workouts ADD COLUMN IF NOT EXISTS pace_min_km      double precision;
ALTER TABLE workouts ADD COLUMN IF NOT EXISTS avg_heart_rate   int;
ALTER TABLE workouts ADD COLUMN IF NOT EXISTS perceived_effort int;   -- RPE 1..10, validated in Go
ALTER TABLE workouts ADD COLUMN IF NOT EXISTS mood             text;
ALTER TABLE workouts ADD COLUMN IF NOT EXISTS location         text;

-- (b) fitness_goals: a target the coach tracks toward. direction makes a goal
-- direction-aware (lose weight = lte, run more = gte, hit exactly = eq). current_value
-- is recomputed on every workout/metric/meal log; status flips to 'achieved' once the
-- direction test passes and is never auto-reverted.
CREATE TABLE IF NOT EXISTS fitness_goals (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    goal_type     text NOT NULL CHECK (goal_type IN ('frequency','metric_target','streak','duration')),
    title         text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
    target_value  double precision NOT NULL,
    target_unit   text,
    metric_type   text,
    category      text,
    direction     text NOT NULL DEFAULT 'gte' CHECK (direction IN ('gte','lte','eq')),
    deadline      date,
    status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','achieved','abandoned')),
    starting_value double precision,
    current_value  double precision,
    notes          text,
    last_nudge_at  timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
-- The active-goals recompute + list query: "this user's goals by status".
CREATE INDEX IF NOT EXISTS fitness_goals_user_status_idx ON fitness_goals (user_id, status);

-- (c) nutrition_log: one logged meal / drink. items_text is the free-text description;
-- macros are optional numbers the agent estimates. logged_on is the day (defaulted to
-- today) so the nutrition stats roll up per calendar day.
CREATE TABLE IF NOT EXISTS nutrition_log (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    meal_type  text,
    items_text text NOT NULL CHECK (char_length(items_text) BETWEEN 1 AND 500),
    calories   int,
    protein_g  double precision,
    carbs_g    double precision,
    fat_g      double precision,
    fiber_g    double precision,
    water_ml   int,
    notes      text,
    logged_on  date NOT NULL DEFAULT (now()::date),
    logged_at  timestamptz NOT NULL DEFAULT now()
);
-- The today / 14-day stats query: "this user's meals, most recent day first".
CREATE INDEX IF NOT EXISTS nutrition_log_user_date_idx ON nutrition_log (user_id, logged_on DESC);

-- (d) fitness_config: one row per user — the coach scheduler's settings. jsonb blobs
-- (workout_split / rest_days / daily_macro_targets) stay schema-free so the shape can
-- evolve without a migration. last_*_at stamps make the 60s scheduler idempotent.
CREATE TABLE IF NOT EXISTS fitness_config (
    user_id             uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled             boolean NOT NULL DEFAULT false,
    checkin_time        text NOT NULL DEFAULT '20:00',
    workout_split       jsonb NOT NULL DEFAULT '{}',
    rest_days           jsonb NOT NULL DEFAULT '[]',
    daily_macro_targets jsonb NOT NULL DEFAULT '{}',
    last_checkin_at     timestamptz,
    last_weekly_at      timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now()
);
