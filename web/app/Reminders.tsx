"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createReminder,
  deleteReminder,
  getReminders,
  setReminderActive,
  type Reminder,
} from "@/lib/gateway";
import { useAuthed } from "./auth/AuthProvider";

// --- humanizer ----------------------------------------------------------------
// The UI NEVER shows a raw cron string; every schedule renders as plain English.
// The chat tool may author arbitrary 5-field crons, so this is best-effort with a
// safe fallback ("a custom schedule") — never the raw expression.

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// A day-of-week field ("1", "1,3", "1-5", "0,6") → "Monday", "Monday and Wednesday",
// … or null if it isn't a plain numeric set we can name.
function expandDow(s: string): string | null {
  const nums: number[] = [];
  for (const part of s.split(",")) {
    if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
      for (let i = a; i <= b; i++) nums.push(i);
    } else {
      const n = Number(part);
      if (!Number.isInteger(n)) return null;
      nums.push(n);
    }
  }
  const names = nums.map((n) => DOW[n === 7 ? 0 : n]).filter(Boolean);
  if (!names.length) return null;
  if (names.length === 1) return names[0];
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

// "0","9" → "9:00 AM"; "" when either field isn't a single integer.
function clockLabel(min: string, hour: string): string {
  const h = Number(hour);
  const m = Number(min);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return "";
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

export function cronToEnglish(cron: string): string {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return "a custom schedule";
  const [min, hour, dom, , dow] = f;

  // Time-of-day phrase.
  let time: string;
  if (hour === "*") time = min === "0" ? "every hour" : `at :${min} past every hour`;
  else if (min === "*") time = "every minute";
  else {
    const c = clockLabel(min, hour);
    time = c ? `at ${c}` : "at a set time";
  }

  // Which days.
  let days: string;
  if (dow === "*" && dom === "*") days = "every day";
  else if (dow === "1-5") days = "every weekday";
  else if (dow === "0,6" || dow === "6,0") days = "every weekend";
  else if (dow !== "*") {
    const names = expandDow(dow);
    days = names ? `every ${names}` : "on a custom schedule";
  } else days = `on day ${dom} of the month`;

  // "every day every hour" reads badly — for sub-daily cadence the time carries it.
  if (days === "every day" && (hour === "*" || min === "*")) {
    return time.charAt(0).toUpperCase() + time.slice(1);
  }
  return `${days} ${time}`;
}

// A one-shot fire_at (ISO/timestamptz) or a next_fire → the viewer's local wall time.
function whenLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// The reminder's schedule as one English line — the only thing the list shows.
function scheduleLabel(r: Reminder): string {
  if (r.kind === "once") return `once, ${whenLabel(r.fire_at) || "at a set time"}`;
  return cronToEnglish(r.cron ?? "");
}

// dev-only self-check for the non-trivial humanizer (mirrors Tasks.tsx `between`).
if (process.env.NODE_ENV !== "production") {
  console.assert(cronToEnglish("0 9 * * 1-5") === "every weekday at 9:00 AM", "cron weekdays");
  console.assert(cronToEnglish("0 * * * *") === "Every hour", "cron hourly");
  console.assert(cronToEnglish("0 9 * * 1") === "every Monday at 9:00 AM", "cron monday");
  console.assert(cronToEnglish("30 14 * * 0,6") === "every weekend at 2:30 PM", "cron weekend");
  console.assert(
    cronToEnglish("0 9 * * 1,2") === "every Monday and Tuesday at 9:00 AM",
    "cron mon+tue",
  );
  console.assert(cronToEnglish("bogus") === "a custom schedule", "cron fallback");
}

// --- create form presets ------------------------------------------------------
// Simple presets that map to a 5-field cron. {H} / {D} are filled from the time /
// weekday inputs at submit. Timezone is force-stamped server-side; the UI never
// sends tz or next_fire. "once" is handled separately via a datetime-local.

type Preset = { value: string; label: string; cron: string | null; needsDay?: boolean };
const PRESETS: Preset[] = [
  { value: "once", label: "Once, at a specific time", cron: null },
  { value: "hourly", label: "Every hour", cron: "0 * * * *" },
  { value: "daily", label: "Every day", cron: "0 {H} * * *" },
  { value: "weekdays", label: "Every weekday (Mon–Fri)", cron: "0 {H} * * 1-5" },
  { value: "weekends", label: "Every weekend (Sat & Sun)", cron: "0 {H} * * 0,6" },
  { value: "weekly", label: "Weekly on…", cron: "0 {H} * * {D}", needsDay: true },
];

export default function Reminders() {
  const { token, failed: onFail } = useAuthed();
  const qc = useQueryClient();
  const {
    data: reminders,
    error,
    isPending,
    refetch,
  } = useQuery({
    queryKey: ["reminders", token],
    queryFn: () => getReminders(token),
    enabled: !!token,
  });

  // Surface a load failure to the shell — this is what drives the single-flight
  // token refresh in page.tsx when a call 401s. A token change re-keys the query
  // above, so a successful refresh refetches automatically.
  useEffect(() => {
    if (error) onFail(error);
  }, [error, onFail]);

  // One mutation for pause/delete/create: run the op, then invalidate so the list
  // refetches canonical state. Per-row "busy" comes from the mutation's variables.
  const mutation = useMutation({
    mutationFn: ({ fn }: { id: string; fn: () => Promise<unknown> }) => fn(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["reminders"] }),
    onError: onFail,
  });
  const busy = mutation.isPending ? mutation.variables?.id ?? null : null;
  const mutate = (id: string, fn: () => Promise<unknown>) => mutation.mutate({ id, fn });

  const items = reminders ?? [];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8">
      <div className="mx-auto flex min-h-0 max-w-2xl flex-col gap-6">
        <div>
          <h2 className="text-2xl font-semibold text-on-surface">Reminders</h2>
          <p className="mt-2 text-sm text-muted">
            Set a one-off or a repeating nudge. When one is due it lands in your
            notifications. You can also just ask in chat — “remind me to drink
            water every hour today”.
          </p>
        </div>

        <CreateForm
          onCreate={(payload) => mutate("__add__", () => createReminder(token, payload))}
        />

        {error && !reminders ? (
          <p className="text-sm text-error">
            Couldn’t load your reminders.{" "}
            <button
              onClick={() => void refetch()}
              className="underline underline-offset-2 hover:text-on-surface"
            >
              Retry
            </button>
          </p>
        ) : isPending ? (
          <p className="text-sm text-faint">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-center text-sm text-faint">No reminders yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((r) => (
              <ReminderRow
                key={r.id}
                reminder={r}
                busy={busy === r.id}
                onPause={(active) =>
                  mutate(r.id, () => setReminderActive(token, r.id, active))
                }
                onDelete={() => mutate(r.id, () => deleteReminder(token, r.id))}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// A single reminder: humanized schedule, next-fire hint, pause/resume, delete.
function ReminderRow({
  reminder: r,
  busy,
  onPause,
  onDelete,
}: {
  reminder: Reminder;
  busy: boolean;
  onPause: (active: boolean) => void;
  onDelete: () => void;
}) {
  const next = r.active ? whenLabel(r.next_fire) : "";
  return (
    <li
      className={`group flex items-start gap-3 rounded-xl border border-edge bg-panel p-3 ${
        busy ? "opacity-40" : ""
      } ${r.active ? "" : "opacity-70"}`}
    >
      <div className="min-w-0 flex-1">
        <p className={`break-words text-sm ${r.active ? "text-on-surface" : "text-muted"}`}>
          {r.text}
        </p>
        <p className="mt-1 text-xs text-muted">
          <span className="capitalize">{scheduleLabel(r)}</span>
          {next && <span className="text-faint"> · next {next}</span>}
          {!r.active && <span className="text-faint"> · paused</span>}
        </p>
      </div>

      <button
        onClick={() => onPause(!r.active)}
        disabled={busy}
        className="shrink-0 rounded-md px-2 py-1 text-xs text-muted transition-colors hover:bg-raised hover:text-on-surface disabled:opacity-40"
      >
        {r.active ? "Pause" : "Resume"}
      </button>
      <button
        onClick={onDelete}
        disabled={busy}
        aria-label={`Delete reminder: ${r.text}`}
        className="shrink-0 rounded-md p-1 text-faint opacity-0 transition-colors hover:bg-raised hover:text-error focus:opacity-100 group-hover:opacity-100 disabled:opacity-40"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
          <path d="M3 6h18" />
          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <path d="M6 6v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6" />
          <path d="M10 11v6M14 11v6" />
        </svg>
      </button>
    </li>
  );
}

type CreatePayload = {
  text: string;
  kind: "once" | "cron";
  cron?: string;
  fire_at?: string;
  until?: string | null;
};

function CreateForm({ onCreate }: { onCreate: (p: CreatePayload) => void }) {
  const [text, setText] = useState("");
  const [preset, setPreset] = useState("daily");
  const [time, setTime] = useState("09:00"); // {H} source for cron presets
  const [day, setDay] = useState("1"); // {D} for the weekly preset
  const [at, setAt] = useState(""); // datetime-local for a one-shot
  const [until, setUntil] = useState(""); // optional recurring bound (date)

  const p = PRESETS.find((x) => x.value === preset)!;
  const isOnce = preset === "once";
  const showTime = !isOnce && p.cron?.includes("{H}");

  function submit() {
    const t = text.trim();
    if (!t) return;
    if (isOnce) {
      if (!at) return;
      // datetime-local is wall time with no zone; send as-is, server stamps tz.
      onCreate({ text: t, kind: "once", fire_at: at });
    } else {
      const hour = Number(time.split(":")[0] || "0");
      const cron = p.cron!.replace("{H}", String(hour)).replace("{D}", day);
      onCreate({
        text: t,
        kind: "cron",
        cron,
        // End-of-day on the chosen date bounds "…today"/"…this week" schedules.
        until: until ? `${until}T23:59:59` : null,
      });
    }
    setText("");
    setAt("");
    setUntil("");
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex flex-col gap-3 rounded-xl border border-edge bg-panel p-4"
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Remind me to…"
        className="w-full rounded-lg border border-edge bg-raised px-3 py-2 text-sm text-on-surface placeholder:text-faint outline-none focus:border-accent"
      />

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={preset}
          onChange={(e) => setPreset(e.target.value)}
          aria-label="Schedule"
          className="rounded-lg border border-edge bg-raised px-2 py-2 text-sm text-on-surface outline-none focus:border-accent"
        >
          {PRESETS.map((x) => (
            <option key={x.value} value={x.value}>
              {x.label}
            </option>
          ))}
        </select>

        {p.needsDay && (
          <select
            value={day}
            onChange={(e) => setDay(e.target.value)}
            aria-label="Day of week"
            className="rounded-lg border border-edge bg-raised px-2 py-2 text-sm text-on-surface outline-none focus:border-accent"
          >
            {DOW.map((name, i) => (
              <option key={i} value={String(i)}>
                {name}
              </option>
            ))}
          </select>
        )}

        {showTime && (
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            aria-label="Time of day"
            className="rounded-lg border border-edge bg-raised px-2 py-2 text-sm text-on-surface outline-none focus:border-accent [color-scheme:dark]"
          />
        )}

        {isOnce && (
          <input
            type="datetime-local"
            value={at}
            onChange={(e) => setAt(e.target.value)}
            aria-label="Date and time"
            className="rounded-lg border border-edge bg-raised px-2 py-2 text-sm text-on-surface outline-none focus:border-accent [color-scheme:dark]"
          />
        )}

        {!isOnce && (
          <label className="flex items-center gap-1 text-xs text-muted">
            until
            <input
              type="date"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              aria-label="Repeat until (optional)"
              className="rounded-lg border border-edge bg-raised px-2 py-2 text-sm text-on-surface outline-none focus:border-accent [color-scheme:dark]"
            />
          </label>
        )}

        <button
          type="submit"
          disabled={!text.trim() || (isOnce && !at)}
          className="ml-auto rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent/90 disabled:opacity-40"
        >
          Add
        </button>
      </div>
    </form>
  );
}
