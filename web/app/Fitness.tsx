"use client";

import { useCallback, useEffect, useState } from "react";
import {
  createMetric,
  createWorkout,
  deleteWorkout,
  getFitnessStats,
  getWorkouts,
  type FitnessStats,
  type Workout,
} from "@/lib/gateway";

// Categories offered in the log form; distance only makes sense for the moving ones.
const CATEGORIES = ["strength", "cardio", "run", "cycling", "swim", "yoga", "other"] as const;
const DISTANCE_CATS = new Set(["run", "cycling", "swim"]);

// A one-shot date (YYYY-MM-DD or timestamptz) → the viewer's local short date.
function dateLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function Fitness({
  token,
  onFail,
}: {
  token: string;
  onFail: (e: unknown) => void;
}) {
  const [stats, setStats] = useState<FitnessStats | null>(null);
  const [workouts, setWorkouts] = useState<Workout[] | null>(null);
  const [error, setError] = useState<unknown>(null); // load failure; enables inline retry
  const [busy, setBusy] = useState<string | null>(null); // id currently mutating

  const load = useCallback(async () => {
    try {
      setError(null);
      const [s, w] = await Promise.all([getFitnessStats(token), getWorkouts(token)]);
      setStats(s);
      setWorkouts(w);
    } catch (e) {
      setError(e);
      onFail(e);
    }
  }, [token, onFail]);

  useEffect(() => {
    void load();
  }, [load]);

  // One guarded mutation, then a reload for canonical state (Reminders pattern).
  const mutate = useCallback(
    async (id: string, fn: () => Promise<unknown>) => {
      setBusy(id);
      try {
        await fn();
        await load();
      } catch (e) {
        onFail(e);
      } finally {
        setBusy(null);
      }
    },
    [load, onFail],
  );

  const items = workouts ?? [];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8">
      <div className="mx-auto flex min-h-0 max-w-2xl flex-col gap-6">
        <div>
          <h2 className="text-2xl font-semibold text-on-surface">Fitness</h2>
          <p className="mt-2 text-sm text-muted">
            Log workouts and track your weight. Your streak and weekly total update
            as you go. You can also just ask in chat — “log a 30 minute run”.
          </p>
        </div>

        {/* Overview */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile label="This week" value={stats ? String(stats.workouts_this_week) : "—"} />
          <StatTile
            label="Streak"
            value={
              stats
                ? `${stats.streak_days} ${stats.streak_days === 1 ? "day" : "days"}`
                : "—"
            }
          />
          <StatTile label="Total" value={stats ? String(stats.total_workouts) : "—"} />
          <StatTile
            label="Latest weight"
            value={
              stats?.latest_weight
                ? `${stats.latest_weight.value} ${stats.latest_weight.unit}`
                : "—"
            }
          />
        </div>

        <LogWorkoutForm
          onCreate={(payload) => mutate("__add__", () => createWorkout(token, payload))}
        />

        <QuickWeightForm
          onCreate={(value, unit) =>
            mutate("__weight__", () => createMetric(token, { metric_type: "weight", value, unit }))
          }
        />

        {/* Recent workouts */}
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-muted">Recent workouts</h3>
          {workouts === null && error ? (
            <p className="text-sm text-error">
              Couldn’t load your workouts.{" "}
              <button
                onClick={() => void load()}
                className="underline underline-offset-2 hover:text-on-surface"
              >
                Retry
              </button>
            </p>
          ) : workouts === null ? (
            <p className="text-sm text-faint">Loading…</p>
          ) : items.length === 0 ? (
            <p className="text-center text-sm text-faint">No workouts yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {items.map((w) => (
                <WorkoutRow
                  key={w.id}
                  workout={w}
                  busy={busy === w.id}
                  onDelete={() => mutate(w.id, () => deleteWorkout(token, w.id))}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-edge bg-panel p-3">
      <p className="text-xs text-faint">{label}</p>
      <p className="mt-1 truncate text-lg font-semibold text-on-surface">{value}</p>
    </div>
  );
}

// A single workout: title, category badge, date, and any recorded figures.
function WorkoutRow({
  workout: w,
  busy,
  onDelete,
}: {
  workout: Workout;
  busy: boolean;
  onDelete: () => void;
}) {
  const bits: string[] = [];
  if (w.duration_min != null) bits.push(`${w.duration_min} min`);
  if (w.calories != null) bits.push(`${w.calories} cal`);
  if (w.distance_km != null) bits.push(`${w.distance_km} km`);
  const when = dateLabel(w.performed_on);
  return (
    <li
      className={`group flex items-start gap-3 rounded-xl border border-edge bg-panel p-3 ${
        busy ? "opacity-40" : ""
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {w.category && (
            <span className="shrink-0 rounded-md bg-raised px-1.5 py-0.5 text-[11px] capitalize text-muted">
              {w.category}
            </span>
          )}
          <p className="break-words text-sm text-on-surface">{w.title}</p>
        </div>
        <p className="mt-1 text-xs text-muted">
          {when && <span>{when}</span>}
          {bits.length > 0 && (
            <span className="text-faint">
              {when ? " · " : ""}
              {bits.join(" · ")}
            </span>
          )}
        </p>
      </div>

      <button
        onClick={onDelete}
        disabled={busy}
        aria-label={`Delete workout: ${w.title}`}
        className="shrink-0 rounded-md p-1 text-faint opacity-0 transition-colors hover:bg-raised hover:text-error focus:opacity-100 group-hover:opacity-100 disabled:opacity-40"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      </button>
    </li>
  );
}

type WorkoutPayload = {
  title: string;
  category: string;
  duration_min?: number | null;
  calories?: number | null;
  distance_km?: number | null;
  notes?: string;
};

function LogWorkoutForm({ onCreate }: { onCreate: (p: WorkoutPayload) => void }) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<string>("strength");
  const [duration, setDuration] = useState("");
  const [calories, setCalories] = useState("");
  const [distance, setDistance] = useState("");
  const [notes, setNotes] = useState("");

  const showDistance = DISTANCE_CATS.has(category);

  // "" → undefined; a numeric string → the number. Keeps empty inputs off the wire.
  const num = (s: string) => (s.trim() === "" ? undefined : Number(s));

  function submit() {
    const t = title.trim();
    if (!t) return;
    onCreate({
      title: t,
      category,
      duration_min: num(duration),
      calories: num(calories),
      distance_km: showDistance ? num(distance) : undefined,
      notes: notes.trim() || undefined,
    });
    setTitle("");
    setDuration("");
    setCalories("");
    setDistance("");
    setNotes("");
  }

  const field =
    "rounded-lg border border-edge bg-raised px-3 py-2 text-sm text-on-surface placeholder:text-faint outline-none focus:border-accent";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex flex-col gap-3 rounded-xl border border-edge bg-panel p-4"
    >
      <h3 className="text-sm font-medium text-muted">Log a workout</h3>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What did you do?"
        className={`w-full ${field}`}
      />

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          aria-label="Category"
          className="rounded-lg border border-edge bg-raised px-2 py-2 text-sm capitalize text-on-surface outline-none focus:border-accent"
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <input
          type="number"
          min="0"
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          placeholder="min"
          aria-label="Duration (minutes)"
          className={`w-20 ${field}`}
        />
        <input
          type="number"
          min="0"
          value={calories}
          onChange={(e) => setCalories(e.target.value)}
          placeholder="cal"
          aria-label="Calories"
          className={`w-20 ${field}`}
        />
        {showDistance && (
          <input
            type="number"
            min="0"
            step="0.1"
            value={distance}
            onChange={(e) => setDistance(e.target.value)}
            placeholder="km"
            aria-label="Distance (km)"
            className={`w-20 ${field}`}
          />
        )}

        <button
          type="submit"
          disabled={!title.trim()}
          className="ml-auto rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent/90 disabled:opacity-40"
        >
          Log
        </button>
      </div>

      <input
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes (optional)"
        className={`w-full ${field}`}
      />
    </form>
  );
}

function QuickWeightForm({ onCreate }: { onCreate: (value: number, unit: string) => void }) {
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("kg");

  function submit() {
    const v = Number(value);
    if (value.trim() === "" || Number.isNaN(v)) return;
    onCreate(v, unit);
    setValue("");
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex flex-wrap items-center gap-2 rounded-xl border border-edge bg-panel p-4"
    >
      <h3 className="mr-auto text-sm font-medium text-muted">Quick log weight</h3>
      <input
        type="number"
        min="0"
        step="0.1"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="weight"
        aria-label="Weight"
        className="w-24 rounded-lg border border-edge bg-raised px-3 py-2 text-sm text-on-surface placeholder:text-faint outline-none focus:border-accent"
      />
      <select
        value={unit}
        onChange={(e) => setUnit(e.target.value)}
        aria-label="Unit"
        className="rounded-lg border border-edge bg-raised px-2 py-2 text-sm text-on-surface outline-none focus:border-accent"
      >
        <option value="kg">kg</option>
        <option value="lb">lb</option>
      </select>
      <button
        type="submit"
        disabled={value.trim() === ""}
        className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent/90 disabled:opacity-40"
      >
        Save
      </button>
    </form>
  );
}
