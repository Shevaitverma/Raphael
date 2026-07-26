"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createGoal,
  createMeal,
  createMetric,
  createWorkout,
  deleteGoal,
  deleteMeal,
  deleteWorkout,
  getBmi,
  getFitnessStats,
  getGoals,
  getMeals,
  getMetrics,
  getNutritionStats,
  getWorkouts,
  updateGoal,
  type Bmi,
  type FitnessStats,
  type Goal,
  type Meal,
  type Metric,
  type NutritionStats,
  type Workout,
} from "@/lib/gateway";
import { useAuthed } from "./auth/AuthProvider";

// Categories offered in the log form; distance only makes sense for the moving ones.
const CATEGORIES = ["strength", "cardio", "run", "cycling", "swim", "yoga", "other"] as const;
const DISTANCE_CATS = new Set(["run", "cycling", "swim"]);

// One hue per category, used for every badge/bar so a category reads the same
// colour everywhere. Hex (not Tailwind classes) so we can tint with an alpha suffix.
const CAT_COLOR: Record<string, string> = {
  strength: "#f59e0b",
  cardio: "#ff6b66",
  run: "#4ade80",
  cycling: "#4d8eff",
  swim: "#22d3ee",
  yoga: "#8b5cf6",
  other: "#8b8b93",
};
const catColor = (c: string | null) => CAT_COLOR[c ?? "other"] ?? CAT_COLOR.other;

const TABS = ["Overview", "Workouts", "Metrics", "Nutrition", "Goals", "Trends"] as const;
type Tab = (typeof TABS)[number];

// A one-shot date (YYYY-MM-DD or timestamptz) → the viewer's local short date.
function dateLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function todayStr(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

// "" → undefined; a numeric string → the number. Keeps empty inputs off the wire.
const num = (s: string) => (s.trim() === "" ? undefined : Number(s));

const field =
  "rounded-lg border border-edge bg-raised px-3 py-2 text-sm text-on-surface placeholder:text-faint outline-none focus:border-accent";

export default function Fitness() {
  const { token, failed: onFail } = useAuthed();
  const [tab, setTab] = useState<Tab>("Overview");

  // Each read is its own query, namespaced under "fitness" so one broad
  // invalidate refreshes them all. Token is in the key → a refresh re-keys and
  // refetches automatically.
  const statsQ = useQuery({ queryKey: ["fitness", "stats", token], queryFn: () => getFitnessStats(token), enabled: !!token });
  const workoutsQ = useQuery({ queryKey: ["fitness", "workouts", token], queryFn: () => getWorkouts(token), enabled: !!token });
  const metricsQ = useQuery({ queryKey: ["fitness", "metrics", token], queryFn: () => getMetrics(token), enabled: !!token });
  const bmiQ = useQuery({ queryKey: ["fitness", "bmi", token], queryFn: () => getBmi(token), enabled: !!token });
  const goalsQ = useQuery({ queryKey: ["fitness", "goals", token], queryFn: () => getGoals(token), enabled: !!token });
  const mealsQ = useQuery({ queryKey: ["fitness", "meals", token], queryFn: () => getMeals(token), enabled: !!token });
  const nutriQ = useQuery({ queryKey: ["fitness", "nutrition", token], queryFn: () => getNutritionStats(token), enabled: !!token });

  const stats = statsQ.data ?? null;
  const workouts = workoutsQ.data;
  const metrics = metricsQ.data;
  const bmi = bmiQ.data ?? null;
  const goals = goalsQ.data;
  const meals = mealsQ.data;
  const nutri = nutriQ.data ?? null;

  // Surface any load failure to the shell (drives the single-flight token refresh).
  const error =
    statsQ.error ?? workoutsQ.error ?? metricsQ.error ?? bmiQ.error ?? goalsQ.error ?? mealsQ.error ?? nutriQ.error ?? null;
  useEffect(() => {
    if (error) onFail(error);
  }, [error, onFail]);

  const refetchAll = () => {
    void statsQ.refetch();
    void workoutsQ.refetch();
    void metricsQ.refetch();
    void bmiQ.refetch();
    void goalsQ.refetch();
    void mealsQ.refetch();
    void nutriQ.refetch();
  };

  // One mutation for every write. A workout/metric/meal recomputes goals + stats
  // + BMI server-side, so onSuccess invalidates the WHOLE "fitness" namespace.
  // Per-row "busy" comes from the mutation's variables (Reminders pattern).
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: ({ fn }: { id: string; fn: () => Promise<unknown> }) => fn(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fitness"] }),
    onError: onFail,
  });
  const busy = mutation.isPending ? mutation.variables?.id ?? null : null;
  const mutate = (id: string, fn: () => Promise<unknown>) => mutation.mutate({ id, fn });

  const loading = workoutsQ.isPending;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8">
      <div className="mx-auto flex min-h-0 max-w-3xl flex-col gap-6">
        <div>
          <h2 className="text-2xl font-semibold text-on-surface">Fitness</h2>
          <p className="mt-2 text-sm text-muted">
            Workouts, body metrics, nutrition and goals — all in one place. You can
            also just ask sage in chat: “log a 30 minute run”.
          </p>
        </div>

        {/* Pill tab switcher */}
        <nav className="flex flex-wrap gap-1.5" aria-label="Fitness sections">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              aria-current={tab === t ? "page" : undefined}
              className={`rounded-full px-3 py-1.5 text-sm transition-colors ${
                tab === t
                  ? "bg-accent text-on-accent"
                  : "text-muted hover:bg-raised hover:text-on-surface"
              }`}
            >
              {t}
            </button>
          ))}
        </nav>

        {error && !workouts ? (
          <div className="flex flex-col items-start gap-2 rounded-xl border border-edge bg-panel px-4 py-3">
            <p className="text-sm text-error">Couldn’t load your fitness data.</p>
            <button
              type="button"
              onClick={refetchAll}
              className="rounded-md border border-edge bg-raised px-3 py-1 text-xs text-on-surface transition-colors hover:bg-panel"
            >
              Retry
            </button>
          </div>
        ) : loading ? (
          <p className="text-sm text-faint">Loading…</p>
        ) : (
          <>
            {tab === "Overview" && (
              <OverviewTab stats={stats} bmi={bmi} workouts={workouts ?? []} />
            )}
            {tab === "Workouts" && (
              <WorkoutsTab
                workouts={workouts ?? []}
                busy={busy}
                onCreate={(p) => mutate("__add__", () => createWorkout(token, p))}
                onDelete={(id) => mutate(id, () => deleteWorkout(token, id))}
              />
            )}
            {tab === "Metrics" && (
              <MetricsTab
                metrics={metrics ?? []}
                onCreate={(value, unit) =>
                  mutate("__weight__", () => createMetric(token, { metric_type: "weight", value, unit }))
                }
              />
            )}
            {tab === "Nutrition" && (
              <NutritionTab
                nutri={nutri}
                meals={meals ?? []}
                busy={busy}
                onDelete={(id) => mutate(id, () => deleteMeal(token, id))}
              />
            )}
            {tab === "Goals" && (
              <GoalsTab
                goals={goals ?? []}
                busy={busy}
                onCreate={(p) => mutate("__goal__", () => createGoal(token, p))}
                onAchieve={(id) => mutate(id, () => updateGoal(token, id, { status: "achieved" }))}
                onDelete={(id) => mutate(id, () => deleteGoal(token, id))}
              />
            )}
            {tab === "Trends" && <TrendsTab stats={stats} />}
          </>
        )}
      </div>
    </div>
  );
}

// --- shared bits --------------------------------------------------------------

function PromptHint({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-full border border-glow/30 bg-glow/10 px-3 py-1.5 text-xs text-glow">
      <span aria-hidden="true">✧</span>
      <span>{text}</span>
    </div>
  );
}

function CategoryBadge({ category }: { category: string | null }) {
  if (!category) return null;
  const c = catColor(category);
  return (
    <span
      className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium capitalize"
      style={{ color: c, backgroundColor: `${c}22` }}
    >
      {category}
    </span>
  );
}

function StatTile({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  accent?: string;
}) {
  return (
    <div className="rounded-xl border border-edge bg-panel p-3">
      <p className="text-xs text-faint">{label}</p>
      <p
        className="mt-1 truncate text-lg font-semibold tabular-nums"
        style={{ color: accent ?? "var(--color-on-surface)" }}
      >
        {value}
      </p>
      {sub != null && <p className="mt-0.5 truncate text-[11px] text-muted">{sub}</p>}
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <p className="rounded-xl border border-edge bg-panel px-4 py-6 text-center text-sm text-faint">{text}</p>;
}

// --- Overview -----------------------------------------------------------------

const BMI_BANDS: Record<string, string> = {
  underweight: "#4d8eff",
  normal: "#4ade80",
  overweight: "#fbbf24",
  obese: "#ff6b66",
};

function OverviewTab({
  stats,
  bmi,
  workouts,
}: {
  stats: FitnessStats | null;
  bmi: Bmi | null;
  workouts: Workout[];
}) {
  const month = todayStr().slice(0, 7);
  const monthHours =
    workouts
      .filter((w) => (w.performed_on ?? "").startsWith(month))
      .reduce((s, w) => s + (w.duration_min ?? 0), 0) / 60;

  const trend = stats?.weight_trend_30d ?? null;
  const streak = stats?.streak_days ?? 0;
  const recent = workouts.slice(0, 5);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <StatTile
          label="This week"
          value={stats ? stats.workouts_this_week : "—"}
          sub={stats ? `avg ${stats.avg_per_week.toFixed(1)}/wk` : undefined}
        />
        <StatTile
          label="Streak"
          value={
            <span>
              <span style={{ opacity: streak === 0 ? 0.35 : 1 }} aria-hidden="true">🔥</span> {streak}
              {streak === 1 ? "d" : "d"}
            </span>
          }
          sub={stats ? `Best: ${stats.longest_streak}d` : undefined}
        />
        <StatTile label="This month" value={monthHours.toFixed(1)} sub="hours" />
        <StatTile
          label="Weight"
          value={
            stats?.latest_weight
              ? `${stats.latest_weight.value} ${stats.latest_weight.unit}`
              : "—"
          }
          sub={
            trend != null && trend !== 0 ? (
              <span style={{ color: trend < 0 ? "#4ade80" : "#fbbf24" }}>
                {trend < 0 ? "↓" : "↑"} {Math.abs(trend).toFixed(1)} / 30d
              </span>
            ) : (
              "—"
            )
          }
        />
        {bmi && bmi.bmi != null ? (
          <StatTile
            label="BMI"
            value={bmi.bmi.toFixed(1)}
            sub={<span className="capitalize">{bmi.category}</span>}
            accent={BMI_BANDS[bmi.category]}
          />
        ) : (
          <StatTile label="BMI" value="—" sub="Log weight + height" />
        )}
      </div>

      <FrequencyChart weekly={stats?.weekly ?? []} />

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-muted">Recent workouts</h3>
        {recent.length === 0 ? (
          <EmptyHint text="Tell sage to log a workout — “ran 5km this morning”." />
        ) : (
          <ul className="flex flex-col gap-2">
            {recent.map((w) => (
              <WorkoutRow key={w.id} workout={w} />
            ))}
          </ul>
        )}
      </div>

      <PromptHint text="Tell sage: “Ran 5km in 28 minutes”" />
    </div>
  );
}

// 12-week frequency bar chart (pure CSS). Bars scale to the busiest week.
function FrequencyChart({ weekly }: { weekly: { week_start: string; count: number }[] }) {
  const max = Math.max(1, ...weekly.map((w) => w.count));
  return (
    <div className="rounded-xl border border-edge bg-panel p-4">
      <h3 className="mb-3 text-sm font-medium text-muted">Last 12 weeks</h3>
      {weekly.length === 0 ? (
        <p className="text-center text-sm text-faint">No workouts yet.</p>
      ) : (
        <div className="flex h-24 items-end gap-1.5">
          {weekly.map((w) => (
            <div key={w.week_start} className="flex flex-1 flex-col items-center gap-1" title={`${dateLabel(w.week_start)}: ${w.count}`}>
              <div
                className="w-full rounded-t bg-accent/70"
                style={{ height: `${(w.count / max) * 100}%`, minHeight: w.count > 0 ? 3 : 0 }}
              />
              <span className="text-[9px] tabular-nums text-faint">{w.count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// A compact workout row used in Overview + Workouts list.
function WorkoutRow({
  workout: w,
  busy,
  onClick,
  onDelete,
}: {
  workout: Workout;
  busy?: boolean;
  onClick?: () => void;
  onDelete?: () => void;
}) {
  const bits: string[] = [];
  const nEx = w.exercises?.length ?? 0;
  if (nEx > 0) bits.push(`${nEx} ex`);
  if (w.duration_min != null) bits.push(`${w.duration_min} min`);
  if (w.perceived_effort != null) bits.push(`RPE ${w.perceived_effort}`);
  const when = dateLabel(w.performed_on);
  return (
    <li
      className={`group flex items-start gap-3 rounded-xl border border-edge bg-panel p-3 ${
        busy ? "opacity-40" : ""
      } ${onClick ? "cursor-pointer transition-colors hover:border-accent/50" : ""}`}
      onClick={onClick}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <CategoryBadge category={w.category} />
          <p className="break-words text-sm text-on-surface">{w.title}</p>
        </div>
        <p className="mt-1 text-xs text-muted">
          {when && <span>{when}</span>}
          {bits.length > 0 && (
            <span className="text-faint tabular-nums">
              {when ? " · " : ""}
              {bits.join(" · ")}
            </span>
          )}
        </p>
      </div>
      {onDelete && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          disabled={busy}
          aria-label={`Delete workout: ${w.title}`}
          className="shrink-0 rounded-md p-1 text-faint opacity-0 transition-colors hover:bg-raised hover:text-error focus:opacity-100 group-hover:opacity-100 disabled:opacity-40"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      )}
    </li>
  );
}

// --- Workouts -----------------------------------------------------------------

function WorkoutsTab({
  workouts,
  busy,
  onCreate,
  onDelete,
}: {
  workouts: Workout[];
  busy: string | null;
  onCreate: (p: WorkoutPayload) => void;
  onDelete: (id: string) => void;
}) {
  const [filter, setFilter] = useState<string>("all");
  const [open, setOpen] = useState<Workout | null>(null);

  const cats = useMemo(
    () => Array.from(new Set(workouts.map((w) => w.category ?? "other"))),
    [workouts],
  );
  const shown = filter === "all" ? workouts : workouts.filter((w) => (w.category ?? "other") === filter);

  return (
    <div className="flex flex-col gap-6">
      <LogWorkoutForm onCreate={onCreate} />

      <div className="flex flex-wrap gap-1.5">
        <FilterPill label="All" active={filter === "all"} onClick={() => setFilter("all")} />
        {cats.map((c) => (
          <FilterPill key={c} label={c} color={catColor(c)} active={filter === c} onClick={() => setFilter(c)} />
        ))}
      </div>

      {shown.length === 0 ? (
        <EmptyHint text="Tell sage to log a workout — “did 5x5 squats at 80kg, RPE 8”." />
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((w) => (
            <WorkoutRow
              key={w.id}
              workout={w}
              busy={busy === w.id}
              onClick={() => setOpen(w)}
              onDelete={() => onDelete(w.id)}
            />
          ))}
        </ul>
      )}

      {open && <WorkoutDetail workout={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function FilterPill({
  label,
  color,
  active,
  onClick,
}: {
  label: string;
  color?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs capitalize transition-colors ${
        active ? "border-accent bg-accent/10 text-on-surface" : "border-edge text-muted hover:bg-raised"
      }`}
    >
      {color && <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />}
      {label}
    </button>
  );
}

function WorkoutDetail({ workout: w, onClose }: { workout: Workout; onClose: () => void }) {
  const grid: [string, string][] = [];
  if (w.duration_min != null) grid.push(["Duration", `${w.duration_min} min`]);
  if (w.perceived_effort != null) grid.push(["RPE", `${w.perceived_effort}/10`]);
  if (w.calories != null) grid.push(["Calories", `${w.calories} cal`]);
  if (w.distance_km != null) grid.push(["Distance", `${w.distance_km} km`]);
  if (w.pace_min_km != null) grid.push(["Pace", `${w.pace_min_km} min/km`]);
  if (w.avg_heart_rate != null) grid.push(["Avg HR", `${w.avg_heart_rate} bpm`]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label="Workout detail">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/50" />
      <div className="relative h-full w-full max-w-md overflow-y-auto border-l border-edge bg-panel p-5">
        <div className="flex items-start gap-2">
          <CategoryBadge category={w.category} />
          <h3 className="min-w-0 flex-1 break-words text-lg font-semibold text-on-surface">{w.title}</h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-md p-1 text-faint transition-colors hover:bg-raised hover:text-on-surface"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
        <p className="mt-1 text-xs text-muted">{dateLabel(w.performed_on)}</p>

        {grid.length > 0 && (
          <div className="mt-4 grid grid-cols-2 gap-2">
            {grid.map(([k, v]) => (
              <div key={k} className="rounded-lg border border-edge bg-raised p-2.5">
                <p className="text-[11px] text-faint">{k}</p>
                <p className="mt-0.5 text-sm font-medium tabular-nums text-on-surface">{v}</p>
              </div>
            ))}
          </div>
        )}

        {w.exercises?.length > 0 && (
          <div className="mt-4">
            <h4 className="mb-2 text-xs font-medium text-muted">Exercises</h4>
            <ul className="flex flex-col gap-1.5">
              {w.exercises.map((e, i) => (
                <li key={i} className="flex items-baseline justify-between gap-2 rounded-lg border border-edge bg-raised px-3 py-2 text-sm">
                  <span className="text-on-surface">{e.name}</span>
                  <span className="tabular-nums text-muted">{exerciseDetail(e)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {(w.mood || w.location) && (
          <p className="mt-4 text-xs text-muted">
            {w.mood && <span>Mood: {w.mood}</span>}
            {w.mood && w.location && <span className="text-faint"> · </span>}
            {w.location && <span>{w.location}</span>}
          </p>
        )}

        {w.notes && <p className="mt-4 whitespace-pre-wrap text-sm text-muted">{w.notes}</p>}
      </div>
    </div>
  );
}

function exerciseDetail(e: Workout["exercises"][number]): string {
  const parts: string[] = [];
  if (e.sets != null && e.reps != null) parts.push(`${e.sets} × ${e.reps}`);
  else if (e.reps != null) parts.push(`${e.reps} reps`);
  if (e.weight_kg != null) parts.push(`@ ${e.weight_kg}kg`);
  if (e.distance_km != null) parts.push(`${e.distance_km}km`);
  if (e.duration_min != null) parts.push(`${e.duration_min}min`);
  return parts.join(" ");
}

type WorkoutPayload = {
  title: string;
  category: string;
  duration_min?: number | null;
  calories?: number | null;
  distance_km?: number | null;
  perceived_effort?: number | null;
  notes?: string;
};

function LogWorkoutForm({ onCreate }: { onCreate: (p: WorkoutPayload) => void }) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<string>("strength");
  const [duration, setDuration] = useState("");
  const [calories, setCalories] = useState("");
  const [distance, setDistance] = useState("");
  const [rpe, setRpe] = useState("");
  const [notes, setNotes] = useState("");

  const showDistance = DISTANCE_CATS.has(category);

  function submit() {
    const t = title.trim();
    if (!t) return;
    onCreate({
      title: t,
      category,
      duration_min: num(duration),
      calories: num(calories),
      distance_km: showDistance ? num(distance) : undefined,
      perceived_effort: num(rpe),
      notes: notes.trim() || undefined,
    });
    setTitle("");
    setDuration("");
    setCalories("");
    setDistance("");
    setRpe("");
    setNotes("");
  }

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

        <input type="number" min="0" value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="min" aria-label="Duration (minutes)" className={`w-20 ${field}`} />
        <input type="number" min="0" value={calories} onChange={(e) => setCalories(e.target.value)} placeholder="cal" aria-label="Calories" className={`w-20 ${field}`} />
        {showDistance && (
          <input type="number" min="0" step="0.1" value={distance} onChange={(e) => setDistance(e.target.value)} placeholder="km" aria-label="Distance (km)" className={`w-20 ${field}`} />
        )}
        <input type="number" min="1" max="10" value={rpe} onChange={(e) => setRpe(e.target.value)} placeholder="RPE" aria-label="Perceived effort (1-10)" className={`w-20 ${field}`} />

        <button
          type="submit"
          disabled={!title.trim()}
          className="ml-auto rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent/90 disabled:opacity-40"
        >
          Log
        </button>
      </div>

      <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" className={`w-full ${field}`} />
    </form>
  );
}

// --- Metrics ------------------------------------------------------------------

function MetricsTab({
  metrics,
  onCreate,
}: {
  metrics: Metric[];
  onCreate: (value: number, unit: string) => void;
}) {
  const types = useMemo(() => Array.from(new Set(metrics.map((m) => m.metric_type))), [metrics]);
  const [type, setType] = useState<string>("");
  const active = type || (types.includes("weight") ? "weight" : types[0]) || "";

  // Oldest → newest for the chart; readings list newest first.
  const series = useMemo(
    () =>
      metrics
        .filter((m) => m.metric_type === active)
        .slice()
        .sort((a, b) => (a.recorded_on ?? "").localeCompare(b.recorded_on ?? "")),
    [metrics, active],
  );

  return (
    <div className="flex flex-col gap-6">
      <QuickWeightForm onCreate={onCreate} />

      {types.length === 0 ? (
        <EmptyHint text="Tell sage to log a measurement — “I weigh 74kg today”." />
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {types.map((t) => (
              <FilterPill key={t} label={t} active={active === t} onClick={() => setType(t)} />
            ))}
          </div>

          <LineChart series={series} />

          <ul className="flex flex-col gap-2">
            {series
              .slice()
              .reverse()
              .map((m) => (
                <li key={m.id} className="flex items-center justify-between rounded-xl border border-edge bg-panel px-3 py-2 text-sm">
                  <span className="tabular-nums text-on-surface">
                    {m.value} {m.unit ?? ""}
                  </span>
                  <span className="text-xs text-muted">{dateLabel(m.recorded_on)}</span>
                </li>
              ))}
          </ul>
        </>
      )}
    </div>
  );
}

// Hand-rolled SVG line + dots over a normalized 0..100 box (preserveAspectRatio none).
function LineChart({ series }: { series: Metric[] }) {
  if (series.length < 2) {
    return (
      <div className="rounded-xl border border-edge bg-panel p-4 text-center text-sm text-faint">
        Log at least two readings to see a trend.
      </div>
    );
  }
  const vals = series.map((m) => m.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const pts = series.map((m, i) => {
    const x = (i / (series.length - 1)) * 100;
    const y = 100 - ((m.value - min) / span) * 100;
    return { x, y, m };
  });
  const line = pts.map((p) => `${p.x},${p.y}`).join(" ");

  return (
    <div className="rounded-xl border border-edge bg-panel p-4">
      <div className="mb-2 flex justify-between text-[11px] tabular-nums text-faint">
        <span>{max}</span>
        <span>{min}</span>
      </div>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-32 w-full" aria-hidden="true">
        <polyline points={line} fill="none" stroke="var(--color-accent)" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
        {pts.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={1.6} fill="var(--color-accent-strong)" vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <div className="mt-1 flex justify-between text-[11px] text-faint">
        <span>{dateLabel(series[0].recorded_on)}</span>
        <span>{dateLabel(series[series.length - 1].recorded_on)}</span>
      </div>
    </div>
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
      <input type="number" min="0" step="0.1" value={value} onChange={(e) => setValue(e.target.value)} placeholder="weight" aria-label="Weight" className={`w-24 ${field}`} />
      <select value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Unit" className="rounded-lg border border-edge bg-raised px-2 py-2 text-sm text-on-surface outline-none focus:border-accent">
        <option value="kg">kg</option>
        <option value="lb">lb</option>
      </select>
      <button type="submit" disabled={value.trim() === ""} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent/90 disabled:opacity-40">
        Save
      </button>
    </form>
  );
}

// --- Nutrition ----------------------------------------------------------------

function NutritionTab({
  nutri,
  meals,
  busy,
  onDelete,
}: {
  nutri: NutritionStats | null;
  meals: Meal[];
  busy: string | null;
  onDelete: (id: string) => void;
}) {
  const today = todayStr();
  const todays = meals.filter((m) => (m.logged_on ?? "").startsWith(today));
  const t = nutri?.today;
  const wa = nutri?.week_avg;
  const tg = nutri?.targets ?? {};

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile
          label="Today calories"
          value={t ? Math.round(t.calories) : "—"}
          sub={tg.calories ? `of ${tg.calories}` : "no target"}
        />
        <StatTile
          label="Today protein"
          value={t ? `${Math.round(t.protein_g)}g` : "—"}
          sub={tg.protein_g ? `of ${tg.protein_g}g` : "no target"}
        />
        <StatTile label="Week avg cal" value={wa ? Math.round(wa.calories) : "—"} sub="/day" />
        <StatTile label="Week avg protein" value={wa ? `${Math.round(wa.protein_g)}g` : "—"} sub="/day" />
      </div>

      <MacroDonut today={t} />

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-muted">Today’s meals</h3>
        {todays.length === 0 ? (
          <EmptyHint text="Tell sage what you ate — “I had eggs and toast”." />
        ) : (
          <ul className="flex flex-col gap-2">
            {todays.map((m) => (
              <li
                key={m.id}
                className={`group flex items-start gap-3 rounded-xl border border-edge bg-panel p-3 ${busy === m.id ? "opacity-40" : ""}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {m.meal_type && (
                      <span className="shrink-0 rounded-md bg-raised px-1.5 py-0.5 text-[11px] capitalize text-muted">{m.meal_type}</span>
                    )}
                    <p className="break-words text-sm text-on-surface">{m.items_text}</p>
                  </div>
                  <p className="mt-1 text-xs tabular-nums text-muted">
                    {m.calories != null && <span>{m.calories} kcal</span>}
                    {m.protein_g != null && <span className="text-faint"> · P{Math.round(m.protein_g)}g</span>}
                  </p>
                </div>
                <button
                  onClick={() => onDelete(m.id)}
                  disabled={busy === m.id}
                  aria-label={`Delete meal: ${m.items_text}`}
                  className="shrink-0 rounded-md p-1 text-faint opacity-0 transition-colors hover:bg-raised hover:text-error focus:opacity-100 group-hover:opacity-100 disabled:opacity-40"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
                    <path d="M18 6 6 18" />
                    <path d="m6 6 12 12" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <PromptHint text="Tell sage: “I had eggs and toast”" />
    </div>
  );
}

const MACROS = [
  { key: "protein_g" as const, label: "Protein", color: "#4d8eff" },
  { key: "carbs_g" as const, label: "Carbs", color: "#fbbf24" },
  { key: "fat_g" as const, label: "Fat", color: "#8b5cf6" },
];

function MacroDonut({ today }: { today: NutritionStats["today"] | undefined }) {
  const r = 42;
  const C = 2 * Math.PI * r;
  const grams = MACROS.map((m) => ({ ...m, g: today?.[m.key] ?? 0 }));
  const total = grams.reduce((s, m) => s + m.g, 0);

  let offset = 0;
  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-edge bg-panel p-4 sm:flex-row sm:justify-center sm:gap-8">
      <svg viewBox="0 0 100 100" className="h-36 w-36 -rotate-90" aria-hidden="true">
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--color-raised)" strokeWidth={10} />
        {total > 0 &&
          grams.map((m) => {
            const frac = m.g / total;
            const dash = frac * C;
            const el = (
              <circle
                key={m.key}
                cx="50"
                cy="50"
                r={r}
                fill="none"
                stroke={m.color}
                strokeWidth={10}
                strokeDasharray={`${dash} ${C - dash}`}
                strokeDashoffset={-offset}
              />
            );
            offset += dash;
            return el;
          })}
        <text x="50" y="50" transform="rotate(90 50 50)" textAnchor="middle" dominantBaseline="central" className="fill-on-surface" style={{ fontSize: 13, fontWeight: 600 }}>
          {today ? Math.round(today.calories) : 0}
        </text>
        <text x="50" y="62" transform="rotate(90 50 50)" textAnchor="middle" dominantBaseline="central" className="fill-faint" style={{ fontSize: 6 }}>
          kcal
        </text>
      </svg>
      <div className="flex flex-col gap-2">
        {grams.map((m) => (
          <div key={m.key} className="flex items-center gap-2 text-sm">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: m.color }} aria-hidden="true" />
            <span className="text-muted">{m.label}</span>
            <span className="tabular-nums text-on-surface">
              {Math.round(m.g)}g · {total > 0 ? Math.round((m.g / total) * 100) : 0}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Goals --------------------------------------------------------------------

const GOAL_TYPES = ["frequency", "metric_target", "streak", "duration"] as const;

function GoalsTab({
  goals,
  busy,
  onCreate,
  onAchieve,
  onDelete,
}: {
  goals: Goal[];
  busy: string | null;
  onCreate: (p: GoalPayload) => void;
  onAchieve: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const active = goals.filter((g) => g.status === "active");
  const achieved = goals.filter((g) => g.status === "achieved");

  return (
    <div className="flex flex-col gap-6">
      <NewGoalForm onCreate={onCreate} />
      <PromptHint text="Tell sage: “I want to run 3 times a week”" />

      {active.length === 0 && achieved.length === 0 ? (
        <EmptyHint text="Tell sage to set a goal — “I want to lose 5kg by September”." />
      ) : (
        <div className="flex flex-col gap-2">
          {active.map((g) => (
            <GoalCard key={g.id} goal={g} busy={busy === g.id} onAchieve={() => onAchieve(g.id)} onDelete={() => onDelete(g.id)} />
          ))}
        </div>
      )}

      {achieved.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-muted">Achieved ({achieved.length})</h3>
          {achieved.map((g) => (
            <GoalCard key={g.id} goal={g} busy={busy === g.id} onAchieve={() => onAchieve(g.id)} onDelete={() => onDelete(g.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function GoalCard({
  goal: g,
  busy,
  onAchieve,
  onDelete,
}: {
  goal: Goal;
  busy: boolean;
  onAchieve: () => void;
  onDelete: () => void;
}) {
  const done = g.status === "achieved";
  const pct = Math.round(Math.min(1, Math.max(0, g.progress_pct)) * 100);
  const cur = g.current_value ?? g.starting_value ?? 0;
  return (
    <div className={`group rounded-xl border border-edge bg-panel p-3 ${busy ? "opacity-40" : ""}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className={`break-words text-sm ${done ? "text-muted line-through" : "text-on-surface"}`}>{g.title}</p>
          <p className="mt-0.5 text-[11px] capitalize text-faint">
            {g.goal_type.replace("_", " ")}
            {g.deadline && <span> · by {dateLabel(g.deadline)}</span>}
          </p>
        </div>
        {!done && (
          <button
            onClick={onAchieve}
            disabled={busy}
            className="shrink-0 rounded-md px-2 py-1 text-xs text-muted transition-colors hover:bg-raised hover:text-success disabled:opacity-40"
          >
            Mark done
          </button>
        )}
        <button
          onClick={onDelete}
          disabled={busy}
          aria-label={`Delete goal: ${g.title}`}
          className="shrink-0 rounded-md p-1 text-faint opacity-0 transition-colors hover:bg-raised hover:text-error focus:opacity-100 group-hover:opacity-100 disabled:opacity-40"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </div>

      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised">
        <div
          className="h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none"
          style={{ width: `${pct}%`, backgroundColor: done ? "var(--color-success)" : "var(--color-accent)" }}
        />
      </div>
      <p className="mt-1 text-[11px] tabular-nums text-muted">
        {cur}/{g.target_value} {g.target_unit ?? ""} · {pct}%
      </p>
    </div>
  );
}

type GoalPayload = {
  goal_type: Goal["goal_type"];
  title: string;
  target_value: number;
  target_unit?: string;
  metric_type?: string;
  starting_value?: number | null;
  direction?: Goal["direction"];
  deadline?: string | null;
};

function NewGoalForm({ onCreate }: { onCreate: (p: GoalPayload) => void }) {
  const [goalType, setGoalType] = useState<Goal["goal_type"]>("frequency");
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState("");
  const [unit, setUnit] = useState("");
  const [deadline, setDeadline] = useState("");
  const [metricType, setMetricType] = useState("weight");
  const [start, setStart] = useState("");
  const [direction, setDirection] = useState<"" | "gte" | "lte">(""); // "" = Auto

  const isMetric = goalType === "metric_target";

  function submit() {
    const t = title.trim();
    const tv = num(target);
    if (!t || tv === undefined) return;
    onCreate({
      goal_type: goalType,
      title: t,
      target_value: tv,
      target_unit: unit.trim() || undefined,
      metric_type: isMetric ? metricType.trim() || undefined : undefined,
      starting_value: isMetric ? num(start) : undefined,
      direction: isMetric && direction ? direction : undefined,
      deadline: deadline || undefined,
    });
    setTitle("");
    setTarget("");
    setUnit("");
    setStart("");
    setDeadline("");
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex flex-col gap-3 rounded-xl border border-edge bg-panel p-4"
    >
      <h3 className="text-sm font-medium text-muted">New goal</h3>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={goalType}
          onChange={(e) => setGoalType(e.target.value as Goal["goal_type"])}
          aria-label="Goal type"
          className="rounded-lg border border-edge bg-raised px-2 py-2 text-sm capitalize text-on-surface outline-none focus:border-accent"
        >
          {GOAL_TYPES.map((t) => (
            <option key={t} value={t}>
              {t.replace("_", " ")}
            </option>
          ))}
        </select>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Goal title" className={`min-w-40 flex-1 ${field}`} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input type="number" step="0.1" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="target" aria-label="Target value" className={`w-24 ${field}`} />
        <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="unit" aria-label="Target unit" className={`w-24 ${field}`} />
        <label className="flex items-center gap-1 text-xs text-muted">
          by
          <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} aria-label="Deadline" className={`${field} [color-scheme:dark]`} />
        </label>
      </div>

      {isMetric && (
        <div className="flex flex-wrap items-center gap-2">
          <input value={metricType} onChange={(e) => setMetricType(e.target.value)} placeholder="metric (e.g. weight)" aria-label="Metric type" className={`w-40 ${field}`} />
          <input type="number" step="0.1" value={start} onChange={(e) => setStart(e.target.value)} placeholder="starting value" aria-label="Starting value" className={`w-32 ${field}`} />
          <select
            value={direction}
            onChange={(e) => setDirection(e.target.value as "" | "gte" | "lte")}
            aria-label="Direction"
            className="rounded-lg border border-edge bg-raised px-2 py-2 text-sm text-on-surface outline-none focus:border-accent"
          >
            <option value="">Auto</option>
            <option value="lte">Decrease</option>
            <option value="gte">Increase</option>
          </select>
        </div>
      )}

      <button
        type="submit"
        disabled={!title.trim() || target.trim() === ""}
        className="ml-auto rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent/90 disabled:opacity-40"
      >
        Add goal
      </button>
    </form>
  );
}

// --- Trends -------------------------------------------------------------------

function TrendsTab({ stats }: { stats: FitnessStats | null }) {
  const byCat = stats?.by_category ?? [];
  const total = byCat.reduce((s, c) => s + c.count, 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile label="Total workouts" value={stats ? stats.total_workouts : "—"} />
        <StatTile label="Avg / week" value={stats ? stats.avg_per_week.toFixed(1) : "—"} />
        <StatTile label="Avg duration" value={stats ? `${Math.round(stats.avg_duration_min)}m` : "—"} />
        <StatTile label="Longest streak" value={stats ? `${stats.longest_streak}d` : "—"} />
      </div>

      <div className="rounded-xl border border-edge bg-panel p-4">
        <h3 className="mb-3 text-sm font-medium text-muted">Category distribution</h3>
        {byCat.length === 0 ? (
          <p className="text-center text-sm text-faint">Tell sage to log workouts to see your mix.</p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {byCat
              .slice()
              .sort((a, b) => b.count - a.count)
              .map((c) => {
                const pct = total > 0 ? Math.round((c.count / total) * 100) : 0;
                return (
                  <li key={c.category} className="flex flex-col gap-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="capitalize text-on-surface">{c.category}</span>
                      <span className="tabular-nums text-muted">
                        {c.count} · {pct}%
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-raised">
                      <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: catColor(c.category) }} />
                    </div>
                  </li>
                );
              })}
          </ul>
        )}
      </div>
    </div>
  );
}
