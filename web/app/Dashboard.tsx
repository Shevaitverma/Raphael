"use client";

import { useEffect, useState } from "react";
import {
  getCapabilities,
  getMemoryStats,
  getPortrait,
  getTasks,
  listProviders,
  type Capabilities,
  type Credential,
  type MemoryStats,
  type Task,
} from "@/lib/gateway";
import { levelForXp, rankForLevel, totalXp } from "@/lib/quests";

const fmt = (n: number) => n.toLocaleString();

// The "Great Sage console": a glowing, alive overview of what Raphael has
// learned and how it's answering right now. Same data wiring as before
// (getMemoryStats / getCapabilities / listProviders) — only the presentation
// is redesigned. Every number on screen is real; nothing is fabricated.
export default function Dashboard({
  token,
  onNavigate,
  onFail,
}: {
  token: string;
  onNavigate: (v: "chat" | "graph" | "settings") => void;
  onFail: (e: unknown) => void;
}) {
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [creds, setCreds] = useState<Credential[] | null>(null);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  // undefined = not loaded yet; "" = loaded but no portrait; string = the portrait.
  const [portrait, setPortrait] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([
      getMemoryStats(token),
      getCapabilities(token),
      listProviders(token),
      getTasks(token),
      getPortrait(token),
    ])
      .then(([s, c, p, t, pt]) => {
        if (!live) return;
        setStats(s);
        setCaps(c);
        setCreds(p);
        setTasks(t);
        setPortrait(pt);
      })
      .catch((e) => {
        if (!live) return;
        setError(e instanceof Error ? e.message : String(e));
        onFail(e); // funnel 401 -> logout; never a silent console.error
      });
    return () => {
      live = false;
    };
  }, [token, onFail]);

  const lifeboat = creds?.find((c) => c.is_lifeboat);
  const empty =
    stats !== null && stats.facts === 0 && stats.episodic === 0 && stats.conversations === 0;
  const active = !!caps?.model;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8">
      <div className="mx-auto flex max-w-4xl flex-col gap-6">
        {error && (
          <div
            role="alert"
            className="border-l-2 border-error bg-error/10 px-3 py-2 text-sm text-error"
          >
            {error}
          </div>
        )}

        {/* Hero — the glowing living Core beside honest, real state. */}
        <section className="glow-violet relative grid gap-6 overflow-hidden rounded-2xl border border-edge bg-panel p-6 md:grid-cols-[auto_1fr] md:items-center md:p-8">
          <Core />

          <div className="min-w-0">
            <h2 className="text-2xl font-semibold text-on-surface">
              {active ? "Raphael is active" : "Raphael is standing by"}
            </h2>
            {caps ? (
              <p className="mt-2 text-sm leading-relaxed text-muted">
                {active ? (
                  <>
                    Answering on{" "}
                    <span className="font-medium text-on-surface">{caps.model}</span> via{" "}
                    <span className="font-medium text-on-surface">
                      {caps.provider || "an active provider"}
                    </span>
                    {typeof caps.max_context_tokens === "number" && (
                      <>
                        , with a{" "}
                        <span className="font-medium text-on-surface">
                          {fmt(caps.max_context_tokens)}-token
                        </span>{" "}
                        context window
                      </>
                    )}
                    .
                  </>
                ) : (
                  "No active provider yet — add one in Settings to bring the core online."
                )}
              </p>
            ) : (
              <p className="mt-2 text-sm text-faint">Waking the core…</p>
            )}

            {/* Honest source of the context number: discovered / static / default. */}
            {caps?.source && (
              <p className="mt-1 text-xs text-faint">
                Context window {caps.source === "discovered" ? "discovered from" : "sourced"} (
                {caps.source})
              </p>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              <Pill on={!!caps?.web_search} label="Web search" />
              <Pill on={!!caps?.google_connected} label="Google" />
              <Pill
                on={!!lifeboat}
                label={lifeboat ? "Fallback ready" : "No fallback"}
                warnOff
                title={lifeboat ? `Degrades to ${lifeboat.model_id}` : undefined}
              />
            </div>
            {creds !== null && !lifeboat && (
              <p className="mt-2 text-xs text-warning">
                If your active credential is rejected the assistant stops instead of degrading.
                Set a fallback in Settings.
              </p>
            )}
          </div>
        </section>

        {/* Gauges — bold, real counts. The bars glow but are decorative; the
            numbers are the truth, so no invented percentages. */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Gauge label="Facts learned" value={stats ? fmt(stats.facts) : "—"} />
          <Gauge label="Memories" value={stats ? fmt(stats.episodic) : "—"} />
          <Gauge label="Conversations" value={stats ? fmt(stats.conversations) : "—"} />
          <Gauge
            label="Context window"
            value={
              typeof caps?.max_context_tokens === "number" ? fmt(caps.max_context_tokens) : "—"
            }
            unit="tokens"
          />
        </div>

        {/* The System — RPG status derived entirely from completed quests
            (tasks). Pure client math via quests.ts: level, rank, EXP. No
            endpoint, no LLM, 0 tokens. The fill width is real progress; its
            glow is static so nothing animates under reduced motion. */}
        <SystemPanel tasks={tasks} />

        {/* Quick start — a real entry to chat, not a fake terminal. It's an
            input-styled button because chat's draft lives elsewhere; typed
            text couldn't be carried honestly, so we open the chat instead. */}
        <section className="rounded-2xl border border-edge bg-panel p-5">
          <h3 className="text-base font-semibold text-on-surface">
            {empty ? "Start a conversation" : "Ask Raphael"}
          </h3>
          <p className="mt-1 text-sm text-muted">
            {empty
              ? "Raphael learns as you talk — facts and memories appear here."
              : "Pick up where you left off, or ask something new."}
          </p>
          <button
            onClick={() => onNavigate("chat")}
            className="mt-4 flex w-full items-center gap-3 rounded-xl border border-edge bg-raised px-4 py-3 text-left text-sm text-faint transition-colors hover:border-accent/50 hover:text-muted"
          >
            <span className="core-hub h-2 w-2 shrink-0 rounded-full bg-accent" aria-hidden />
            Ask Raphael anything…
            <span className="ml-auto shrink-0 rounded-md bg-accent px-3 py-1 text-xs font-medium text-on-accent">
              Start a conversation
            </span>
          </button>
        </section>

        {/* How Raphael sees you — the exact persona portrait.synthesize() writes
            and workflow injects into every system prompt. Read-only 0-token door;
            completes transparency so the user can see what Raphael assumes about them. */}
        <section className="rounded-2xl border border-edge bg-panel p-5">
          <h3 className="text-base font-semibold text-on-surface">How Raphael sees you</h3>
          {portrait === undefined ? (
            <p className="mt-3 text-sm text-faint">Loading…</p>
          ) : portrait ? (
            <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-muted">{portrait}</p>
          ) : (
            <p className="mt-3 text-sm text-faint">
              No portrait yet — Raphael forms one as it learns about you.
            </p>
          )}
        </section>

        {/* Recent knowledge — the strongest facts Raphael actually knows. */}
        <section className="rounded-2xl border border-edge bg-panel p-5">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-on-surface">Recent knowledge</h3>
            <ActivitySparkline activity={stats?.activity ?? []} />
          </div>
          <div className="mt-3 flex flex-col divide-y divide-edge">
            {stats === null && <p className="py-3 text-sm text-faint">Loading…</p>}
            {stats && stats.top_facts.length === 0 && (
              <p className="py-3 text-sm text-faint">
                Nothing learned yet — chat with Raphael and facts appear here.
              </p>
            )}
            {(stats?.top_facts ?? []).map((f, i) => (
              <div key={i} className="flex items-center justify-between gap-3 py-2.5">
                <p className="min-w-0 text-sm text-on-surface">
                  <span className="font-medium">{f.subject}</span>{" "}
                  <span className="text-muted">{f.predicate}</span>{" "}
                  <span className="font-medium">{f.object}</span>
                </p>
                <div className="flex shrink-0 items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted">
                  <span className="rounded-md bg-raised px-2 py-0.5">
                    {Math.round(f.confidence * 100)}%
                  </span>
                  <span className="rounded-md bg-raised px-2 py-0.5">
                    seen {fmt(f.times_seen)}×
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Quick links */}
        <div className="flex flex-wrap gap-2">
          <QuickLink label="Open graph" onClick={() => onNavigate("graph")} />
          <QuickLink label="Settings" onClick={() => onNavigate("settings")} />
        </div>
      </div>
    </div>
  );
}

// The living core: a soft radial halo, faint concentric rings, two slowly
// counter-rotating dashed rings and a breathing hub. Pure decoration — real
// state lives in the readable text beside it, so this is aria-hidden. Motion
// is CSS-only and disabled under prefers-reduced-motion (see globals.css).
function Core() {
  return (
    <div className="relative grid h-40 w-40 shrink-0 place-items-center md:h-48 md:w-48" aria-hidden>
      <div className="anim-breathe core-glow absolute inset-2 rounded-full" />
      <svg viewBox="0 0 220 220" className="relative h-full w-full">
        <g fill="none">
          <circle cx="110" cy="110" r="100" stroke="var(--color-edge)" strokeWidth="1" />
          <circle
            cx="110"
            cy="110"
            r="80"
            stroke="var(--color-edge)"
            strokeWidth="1"
            opacity="0.7"
          />
          <circle
            cx="110"
            cy="110"
            r="58"
            stroke="var(--color-edge)"
            strokeWidth="1"
            opacity="0.5"
          />
          <circle
            cx="110"
            cy="110"
            r="100"
            stroke="var(--color-accent)"
            strokeWidth="1.5"
            strokeDasharray="2 12"
            opacity="0.8"
            className="anim-rotate spin-center"
          />
          <circle
            cx="110"
            cy="110"
            r="80"
            stroke="var(--color-glow)"
            strokeWidth="1.5"
            strokeDasharray="34 210"
            strokeLinecap="round"
            opacity="0.75"
            className="anim-rotate-rev spin-center"
          />
        </g>
        <circle
          cx="110"
          cy="110"
          r="16"
          fill="var(--color-accent)"
          className="core-hub anim-breathe spin-center"
        />
      </svg>
    </div>
  );
}

function Gauge({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="glow-accent rounded-2xl border border-edge bg-panel p-4">
      <p className="text-[11px] uppercase tracking-widest text-faint">{label}</p>
      <p className="mt-2 flex items-baseline gap-1">
        <span className="text-3xl font-semibold tabular-nums text-on-surface">{value}</span>
        {unit && <span className="text-xs text-faint">{unit}</span>}
      </p>
      {/* decorative glowing rail — not a ratio, just a sign of life */}
      <div className="mt-3 h-1 rounded-full bg-gradient-to-r from-accent to-glow opacity-80" />
    </div>
  );
}

// "The System" — an isekai-inspired but original status readout. Everything is
// DERIVED from the same getTasks() the board uses: EXP = sum of completed
// quests' rewards, level/rank from quests.ts. No fabricated numbers.
function SystemPanel({ tasks }: { tasks: Task[] | null }) {
  const xp = totalXp(tasks ?? []);
  const info = levelForXp(xp);
  const rank = rankForLevel(info.level);
  const completed = (tasks ?? []).filter((t) => t.status === "done").length;
  const pct = Math.round(info.progress * 100);

  return (
    <section className="glow-violet rounded-2xl border border-edge bg-panel p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-on-surface">The System</h3>
        <span className="rounded-md bg-accent/15 px-2.5 py-1 text-xs font-medium text-accent">
          {rank.name}
        </span>
      </div>

      <div className="mt-4 flex items-baseline gap-3">
        <span className="text-[11px] uppercase tracking-widest text-faint">Level</span>
        <span className="text-4xl font-semibold tabular-nums text-on-surface">
          {tasks === null ? "—" : info.level}
        </span>
      </div>

      {/* EXP progress bar — width is real (xpIntoLevel / xpForThisLevel);
          the fill glow is a static box-shadow, so reduced motion sees no change. */}
      <div className="mt-4">
        <div
          className="h-2 overflow-hidden rounded-full bg-raised"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`EXP ${info.xpIntoLevel} of ${info.xpForThisLevel} into level ${info.level}`}
        >
          <div
            className="glow-accent h-full rounded-full bg-gradient-to-r from-accent to-glow"
            style={{ width: `${tasks === null ? 0 : Math.max(pct, info.xpIntoLevel > 0 ? 2 : 0)}%` }}
          />
        </div>
        <p className="mt-1.5 text-xs text-faint">
          {tasks === null
            ? "Reading the System…"
            : `${fmt(info.xpIntoLevel)} / ${fmt(info.xpForThisLevel)} EXP — ${fmt(info.xpForNext)} to level ${info.level + 1}`}
        </p>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-edge bg-raised px-3 py-2">
          <p className="text-[11px] uppercase tracking-widest text-faint">Total EXP</p>
          <p className="mt-1 text-xl font-semibold tabular-nums text-on-surface">
            {tasks === null ? "—" : fmt(xp)}
          </p>
        </div>
        <div className="rounded-xl border border-edge bg-raised px-3 py-2">
          <p className="text-[11px] uppercase tracking-widest text-faint">Quests cleared</p>
          <p className="mt-1 text-xl font-semibold tabular-nums text-on-surface">
            {tasks === null ? "—" : fmt(completed)}
          </p>
        </div>
      </div>
    </section>
  );
}

function Pill({
  on,
  label,
  warnOff,
  title,
}: {
  on: boolean;
  label: string;
  warnOff?: boolean;
  title?: string;
}) {
  const cls = on
    ? "bg-accent/15 text-accent"
    : warnOff
      ? "bg-warning/10 text-warning"
      : "bg-raised text-faint";
  const dot = on ? "bg-accent" : warnOff ? "bg-warning" : "bg-faint";
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs ${cls}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
      {!warnOff && ` ${on ? "on" : "off"}`}
    </span>
  );
}

// Hand-rolled 14-day sparkline, no dependency. Falls back to a plain count when
// there's not enough to draw a line.
function ActivitySparkline({ activity }: { activity: { day: string; count: number }[] }) {
  const total = activity.reduce((s, a) => s + a.count, 0);
  if (activity.length < 2) {
    return <span className="text-xs text-muted">{fmt(total)} learned recently</span>;
  }
  const w = 90;
  const h = 24;
  const max = Math.max(1, ...activity.map((a) => a.count));
  const pts = activity
    .map((a, i) => {
      const x = (i / (activity.length - 1)) * w;
      const y = h - (a.count / max) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={`${fmt(total)} facts learned across the last ${activity.length} days`}
      className="overflow-visible"
    >
      <polyline
        points={pts}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function QuickLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded-md border border-edge px-3 py-1.5 text-sm text-muted transition-colors hover:bg-raised hover:text-on-surface"
    >
      {label}
    </button>
  );
}
