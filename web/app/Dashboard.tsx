"use client";

import { useEffect, useState } from "react";
import {
  getCapabilities,
  getMemoryStats,
  listProviders,
  type Capabilities,
  type Credential,
  type MemoryStats,
} from "@/lib/gateway";

const fmt = (n: number) => n.toLocaleString();

// Overview of what Raphael has learned: real stats + the live model/provider
// state. Mirrors the reference dashboard's IA (hero, provider cards, knowledge
// feed, sync ring) with this app's flat theme and only real data.
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([getMemoryStats(token), getCapabilities(token), listProviders(token)])
      .then(([s, c, p]) => {
        if (!live) return;
        setStats(s);
        setCaps(c);
        setCreds(p);
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

        <div>
          <h2 className="text-2xl font-semibold text-on-surface">Overview</h2>
          <p className="mt-1 text-sm text-muted">
            What Raphael has learned, and how it&apos;s answering right now.
          </p>
        </div>

        {/* Empty state — a fresh account, not an error. */}
        {empty && (
          <div className="rounded-xl border border-edge bg-panel px-5 py-8 text-center">
            <p className="text-sm text-on-surface">
              Start a conversation — Raphael learns as you talk.
            </p>
            <p className="mt-1 text-sm text-faint">
              Facts and memories will show up here once you&apos;ve chatted a bit.
            </p>
            <button
              onClick={() => onNavigate("chat")}
              className="mt-4 rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong"
            >
              Start a chat
            </button>
          </div>
        )}

        {/* Stat tiles */}
        <div className="grid grid-cols-3 gap-3">
          <StatTile label="Facts" value={stats ? fmt(stats.facts) : "—"} />
          <StatTile label="Memories" value={stats ? fmt(stats.episodic) : "—"} />
          <StatTile label="Conversations" value={stats ? fmt(stats.conversations) : "—"} />
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {/* Active model */}
          <div className="rounded-xl border border-edge bg-panel p-4">
            <h3 className="text-[11px] uppercase tracking-widest text-faint">Active model</h3>
            {caps ? (
              <>
                <p className="mt-2 text-lg font-semibold text-on-surface">
                  {caps.model || "—"}
                </p>
                <p className="text-sm text-muted">{caps.provider || "no active provider"}</p>
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                  {typeof caps.max_context_tokens === "number" && (
                    <span>{fmt(caps.max_context_tokens)} tokens context</span>
                  )}
                  {caps.source && (
                    // Honest about HOW it knows the window: discovered vs guessed.
                    <span className="rounded-md bg-raised px-2 py-0.5 text-[10px] uppercase tracking-widest">
                      {caps.source}
                    </span>
                  )}
                </div>
              </>
            ) : (
              <p className="mt-2 text-sm text-faint">Loading…</p>
            )}
          </div>

          {/* Fallback / lifeboat + connectors */}
          <div className="rounded-xl border border-edge bg-panel p-4">
            <h3 className="text-[11px] uppercase tracking-widest text-faint">Fallback</h3>
            {creds === null ? (
              <p className="mt-2 text-sm text-faint">Loading…</p>
            ) : lifeboat ? (
              <p className="mt-2 text-sm text-on-surface">
                Fallback set:{" "}
                <span className="font-medium">{lifeboat.model_id}</span>. A rejected active
                credential degrades to it instead of stopping.
              </p>
            ) : (
              <p className="mt-2 text-sm text-warning">
                No fallback set. If your active credential is rejected, the assistant will stop
                instead of degrading. Set one in Settings.
              </p>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              <Pill on={!!caps?.web_search} label="Web search" />
              <Pill on={!!caps?.google_connected} label="Google" />
            </div>
          </div>
        </div>

        {/* Recent knowledge — the reference's "Recent Knowledge Extraction", real. */}
        <div className="rounded-xl border border-edge bg-panel p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-on-surface">Recent knowledge</h3>
            <ActivitySparkline activity={stats?.activity ?? []} />
          </div>
          <div className="mt-3 flex flex-col divide-y divide-edge">
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
        </div>

        {/* Quick links */}
        <div className="flex flex-wrap gap-2">
          <QuickLink label="Start a chat" onClick={() => onNavigate("chat")} />
          <QuickLink label="Open graph" onClick={() => onNavigate("graph")} />
          <QuickLink label="Settings" onClick={() => onNavigate("settings")} />
        </div>
      </div>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-edge bg-panel p-4">
      <p className="text-3xl font-semibold tabular-nums text-on-surface">{value}</p>
      <p className="mt-1 text-sm text-muted">{label}</p>
    </div>
  );
}

function Pill({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs ${
        on ? "bg-accent/15 text-accent" : "bg-raised text-faint"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-accent" : "bg-faint"}`} />
      {label} {on ? "on" : "off"}
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
