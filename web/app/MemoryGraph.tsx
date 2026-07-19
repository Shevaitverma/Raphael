"use client";

import { useEffect, useMemo, useState } from "react";
import {
  getMemoryGraph,
  type GraphData,
  type GraphEdge,
  type GraphNode,
} from "@/lib/gateway";

const fmt = (n: number) => n.toLocaleString();
const pct = (c: number) => `${Math.round(c * 100)}%`;

// Fixed canvas. The data is a user-centric STAR (an identity node with facts
// radiating out), so a deterministic radial layout beats a physics engine and
// needs zero dependencies.
const VB_W = 820;
const VB_H = 560;
const CX = VB_W / 2;
const CY = VB_H / 2;
// Radius per BFS ring (0 = center). Chosen so ring 2 + its node + label stay
// inside the canvas and inside the decorative outer circle at RING_OUTER.
const RINGS = [0, 120, 210];
const RING_OUTER = 250;

type Placed = GraphNode & { x: number; y: number; r: number };

export default function MemoryGraph({
  token,
  onNavigate,
  onFail,
}: {
  token: string;
  onNavigate: (v: "chat") => void;
  onFail: (e: unknown) => void;
}) {
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"graph" | "list">("graph");
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [showNotes, setShowNotes] = useState(false);
  // Once the data lands, a big or truncated graph defaults to the List view —
  // the SVG is unreadable past ~60 nodes. The user can still flip back.
  const [autoListed, setAutoListed] = useState(false);

  useEffect(() => {
    let live = true;
    getMemoryGraph(token)
      .then((g) => {
        if (!live) return;
        setGraph(g);
        if (!autoListed && (g.nodes.length > 60 || g.truncated)) {
          setMode("list");
          setAutoListed(true);
        }
      })
      .catch((e) => {
        if (!live) return;
        setError(e instanceof Error ? e.message : String(e));
        onFail(e);
      });
    return () => {
      live = false;
    };
    // autoListed intentionally omitted: we only want the initial fetch to set it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, onFail]);

  const placed = useMemo(() => (graph ? layout(graph) : new Map<string, Placed>()), [graph]);

  // Adjacency for neighbor-highlighting on hover/select.
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const add = (a: string, b: string) =>
      (m.get(a) ?? m.set(a, new Set()).get(a)!).add(b);
    for (const e of graph?.edges ?? []) {
      add(e.source, e.target);
      add(e.target, e.source);
    }
    return m;
  }, [graph]);

  // Honour prefers-reduced-motion: when reduced, we render the graph fully
  // static (no SMIL rotation, no pulse) — the decorative motion is the only
  // thing gated; data and interactions are untouched.
  const [motion, setMotion] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setMotion(!mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  if (error) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8">
        <div className="mx-auto max-w-4xl">
          <div
            role="alert"
            className="border-l-2 border-error bg-error/10 px-3 py-2 text-sm text-error"
          >
            {error}
          </div>
        </div>
      </div>
    );
  }

  if (!graph) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8">
        <p className="mx-auto max-w-4xl text-sm text-faint">Loading…</p>
      </div>
    );
  }

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const empty = graph.nodes.length === 0;
  const activeId = hovered ?? selected;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-2xl font-semibold text-on-surface">Knowledge graph</h2>
            <p className="mt-1 text-sm text-muted">
              What Raphael knows about you and how the pieces connect.
            </p>
          </div>
          <div className="flex rounded-md border border-edge bg-panel p-0.5 text-sm">
            {(["graph", "list"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded px-3 py-1 capitalize transition-colors ${
                  mode === m
                    ? "bg-raised font-medium text-on-surface"
                    : "text-muted hover:text-on-surface"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        {graph.truncated && (
          <div
            role="status"
            className="border-l-2 border-warning bg-warning/10 px-3 py-2 text-sm text-warning"
          >
            Showing the 200 most-reinforced facts.
          </div>
        )}

        {empty ? (
          <div className="rounded-xl border border-edge bg-panel px-5 py-10 text-center">
            <p className="text-sm text-faint">
              Raphael hasn&apos;t learned anything about you yet. Chat with it and it&apos;ll
              start remembering.
            </p>
            <button
              onClick={() => onNavigate("chat")}
              className="mt-4 rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong"
            >
              Start a chat
            </button>
          </div>
        ) : mode === "graph" ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_18rem]">
            <div className="overflow-x-auto rounded-xl border border-edge bg-[#0b0b12]">
              <svg
                viewBox={`0 0 ${VB_W} ${VB_H}`}
                role="img"
                aria-label={`knowledge graph, ${fmt(graph.edges.length)} facts`}
                className="w-full select-none"
              >
                <defs>
                  {/* Celestial violet field behind everything. */}
                  <radialGradient id="mg-field" cx="50%" cy="50%" r="55%">
                    <stop offset="0%" stopColor="#5b4bd6" stopOpacity="0.22" />
                    <stop offset="55%" stopColor="#3a2f8a" stopOpacity="0.08" />
                    <stop offset="100%" stopColor="#3a2f8a" stopOpacity="0" />
                  </radialGradient>
                  {/* Core aura of the identity node. */}
                  <radialGradient id="mg-core" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="var(--color-accent-strong)" stopOpacity="0.95" />
                    <stop offset="45%" stopColor="var(--color-accent)" stopOpacity="0.55" />
                    <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
                  </radialGradient>
                  {/* Soft halo for glowing strokes/nodes. */}
                  <filter id="mg-glow" x="-120%" y="-120%" width="340%" height="340%">
                    <feGaussianBlur stdDeviation="3.2" result="b" />
                    <feMerge>
                      <feMergeNode in="b" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                </defs>

                {/* ---- decorative sage's circle (purely ornamental) ---- */}
                <g aria-hidden="true">
                  <circle cx={CX} cy={CY} r={RING_OUTER + 10} fill="url(#mg-field)" />

                  {/* Concentric magic-circle rings. */}
                  {[RINGS[1], RINGS[2], RING_OUTER].map((r, i) => (
                    <circle
                      key={r}
                      cx={CX}
                      cy={CY}
                      r={r}
                      fill="none"
                      stroke="var(--color-accent)"
                      strokeOpacity={0.12 + i * 0.04}
                      strokeWidth={i === 2 ? 1 : 0.6}
                      strokeDasharray={i === 1 ? "2 8" : undefined}
                    />
                  ))}

                  {/* Slowly rotating tick ring — the "analytical" dial. */}
                  <g>
                    {motion && (
                      <animateTransform
                        attributeName="transform"
                        type="rotate"
                        from={`0 ${CX} ${CY}`}
                        to={`360 ${CX} ${CY}`}
                        dur="90s"
                        repeatCount="indefinite"
                      />
                    )}
                    {Array.from({ length: 60 }).map((_, i) => {
                      const a = (i / 60) * Math.PI * 2;
                      const major = i % 5 === 0;
                      const r1 = RING_OUTER;
                      const r2 = RING_OUTER - (major ? 12 : 6);
                      return (
                        <line
                          key={i}
                          x1={CX + Math.cos(a) * r1}
                          y1={CY + Math.sin(a) * r1}
                          x2={CX + Math.cos(a) * r2}
                          y2={CY + Math.sin(a) * r2}
                          stroke="var(--color-accent)"
                          strokeOpacity={major ? 0.4 : 0.18}
                          strokeWidth={major ? 1.1 : 0.6}
                        />
                      );
                    })}
                  </g>

                  {/* Counter-rotating dashed inner ring, for gentle depth. */}
                  <g>
                    {motion && (
                      <animateTransform
                        attributeName="transform"
                        type="rotate"
                        from={`360 ${CX} ${CY}`}
                        to={`0 ${CX} ${CY}`}
                        dur="70s"
                        repeatCount="indefinite"
                      />
                    )}
                    <circle
                      cx={CX}
                      cy={CY}
                      r={RINGS[1] - 14}
                      fill="none"
                      stroke="var(--color-accent)"
                      strokeOpacity={0.18}
                      strokeWidth={0.8}
                      strokeDasharray="1 10"
                    />
                  </g>
                </g>

                {/* ---- edges (glowing filaments) ---- */}
                {graph.edges.map((e, i) => {
                  const a = placed.get(e.source);
                  const b = placed.get(e.target);
                  if (!a || !b) return null;
                  const active = activeId === e.source || activeId === e.target;
                  const dim = activeId != null && !active;
                  return (
                    <line
                      key={i}
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      stroke="var(--color-accent)"
                      strokeOpacity={active ? 0.95 : dim ? 0.06 : 0.22}
                      strokeWidth={strokeFor(e.times_seen)}
                      filter={active ? "url(#mg-glow)" : undefined}
                      style={{ transition: "stroke-opacity 200ms ease" }}
                    />
                  );
                })}

                {/* ---- nodes ---- */}
                {[...placed.values()].map((n) => {
                  const isActive = activeId === n.id;
                  const isNeighbor = activeId != null && (neighbors.get(activeId)?.has(n.id) ?? false);
                  const dim = activeId != null && !isActive && !isNeighbor;
                  const lit = isActive || isNeighbor || selected === n.id;
                  const identity = n.kind === "identity";
                  return (
                    <g
                      key={n.id}
                      className="cursor-pointer"
                      onMouseEnter={() => setHovered(n.id)}
                      onMouseLeave={() => setHovered(null)}
                      onClick={() => setSelected(n.id)}
                      style={{ transition: "opacity 200ms ease" }}
                      opacity={dim ? 0.35 : 1}
                    >
                      {/* Aura: pulsing for identity, on-demand for lit entities. */}
                      {(identity || lit) && (
                        <circle
                          cx={n.x}
                          cy={n.y}
                          r={n.r * (identity ? 2.6 : 1.9)}
                          fill="url(#mg-core)"
                          opacity={identity ? 0.9 : 0.6}
                        >
                          {identity && motion && (
                            <animate
                              attributeName="opacity"
                              values="0.55;0.95;0.55"
                              dur="4s"
                              repeatCount="indefinite"
                            />
                          )}
                        </circle>
                      )}
                      <circle
                        cx={n.x}
                        cy={n.y}
                        r={n.r}
                        fill={identity ? "var(--color-accent)" : "var(--color-raised)"}
                        stroke={
                          identity
                            ? "var(--color-accent-strong)"
                            : lit
                              ? "var(--color-accent)"
                              : "var(--color-edge)"
                        }
                        strokeWidth={identity ? 2.5 : lit ? 2 : 1.25}
                        filter={lit ? "url(#mg-glow)" : undefined}
                        style={{ transition: "stroke 200ms ease" }}
                      />
                      <text
                        x={n.x}
                        y={n.y + n.r + 13}
                        textAnchor="middle"
                        fontSize="11"
                        fill={lit || identity ? "var(--color-on-surface)" : "var(--color-muted)"}
                        style={{ transition: "fill 200ms ease" }}
                      >
                        {truncate(n.label, 18)}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>

            <InspectPanel
              nodeId={selected}
              nodeById={nodeById}
              edges={graph.edges}
              onClear={() => setSelected(null)}
            />
          </div>
        ) : (
          <ListView edges={graph.edges} nodeById={nodeById} />
        )}

        {graph.notes.length > 0 && (
          <div className="rounded-xl border border-edge bg-panel p-4">
            <button
              onClick={() => setShowNotes((s) => !s)}
              className="flex w-full items-center justify-between text-left text-sm font-medium text-on-surface"
              aria-expanded={showNotes}
            >
              <span>Things Raphael remembers ({fmt(graph.notes.length)})</span>
              <span className="text-muted">{showNotes ? "–" : "+"}</span>
            </button>
            {showNotes && (
              <ul className="mt-3 flex flex-col gap-2">
                {graph.notes.map((note) => (
                  <li key={note.id} className="flex items-start justify-between gap-3 text-sm">
                    <span className="min-w-0 text-on-surface">{note.content}</span>
                    <span className="shrink-0 rounded-md bg-raised px-2 py-0.5 text-[10px] uppercase tracking-widest text-muted">
                      {pct(note.confidence)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Right-side panel: the selected node's facts with provenance. The List view is
// the screen-reader-friendly equivalent; this is the point-and-inspect path.
function InspectPanel({
  nodeId,
  nodeById,
  edges,
  onClear,
}: {
  nodeId: string | null;
  nodeById: Map<string, GraphNode>;
  edges: GraphEdge[];
  onClear: () => void;
}) {
  if (!nodeId) {
    return (
      <div className="rounded-xl border border-edge bg-panel p-4 text-sm text-faint">
        Click a node to see its facts.
      </div>
    );
  }
  const node = nodeById.get(nodeId);
  // Every edge touching this node, phrased from its point of view.
  const incident = edges
    .filter((e) => e.source === nodeId || e.target === nodeId)
    .map((e) => {
      const otherId = e.source === nodeId ? e.target : e.source;
      return { edge: e, other: nodeById.get(otherId)?.label ?? otherId };
    });

  return (
    <div className="rounded-xl border border-edge bg-panel p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-base font-semibold text-on-surface">{node?.label ?? nodeId}</h3>
        <button onClick={onClear} className="text-xs text-muted hover:text-on-surface">
          Clear
        </button>
      </div>
      <div className="mt-3 flex flex-col gap-3">
        {incident.length === 0 && <p className="text-sm text-faint">No facts on this node.</p>}
        {incident.map(({ edge, other }, i) => (
          <div key={i} className="border-l-2 border-edge pl-3 text-sm">
            <p className="text-on-surface">
              <span className="text-muted">{edge.label}</span> {other}
            </p>
            <p className="mt-0.5 text-xs text-muted">
              {pct(edge.confidence)} · seen {fmt(edge.times_seen)}×
              {edge.first_seen ? ` · since ${shortDate(edge.first_seen)}` : ""}
              {edge.last_seen ? ` · last ${shortDate(edge.last_seen)}` : ""}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

// The accessible alternative AND the large-graph fallback: relations grouped by
// predicate, as real DOM.
function ListView({
  edges,
  nodeById,
}: {
  edges: GraphEdge[];
  nodeById: Map<string, GraphNode>;
}) {
  const groups = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    const g = groups.get(e.label) ?? [];
    g.push(e);
    groups.set(e.label, g);
  }
  const label = (id: string) => nodeById.get(id)?.label ?? id;

  return (
    <div className="flex flex-col gap-4">
      {[...groups.entries()].map(([predicate, es]) => (
        <div key={predicate} className="rounded-xl border border-edge bg-panel p-4">
          <h3 className="text-[11px] uppercase tracking-widest text-faint">{predicate}</h3>
          <div className="mt-2 flex flex-col divide-y divide-edge">
            {es.map((e, i) => (
              <div key={i} className="flex items-center justify-between gap-3 py-2 text-sm">
                <p className="min-w-0 text-on-surface">
                  <span className="font-medium">{label(e.source)}</span>{" "}
                  <span className="text-muted">{predicate}</span>{" "}
                  <span className="font-medium">{label(e.target)}</span>
                </p>
                <span className="shrink-0 text-[10px] uppercase tracking-widest text-muted">
                  {pct(e.confidence)} · {fmt(e.times_seen)}×
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// --- radial layout -----------------------------------------------------------
// BFS ring levels from the identity node; place each ring evenly by angle.
function layout(graph: GraphData): Map<string, Placed> {
  const out = new Map<string, Placed>();
  if (graph.nodes.length === 0) return out;

  const adj = new Map<string, string[]>();
  for (const n of graph.nodes) adj.set(n.id, []);
  for (const e of graph.edges) {
    adj.get(e.source)?.push(e.target);
    adj.get(e.target)?.push(e.source);
  }

  const root =
    graph.nodes.find((n) => n.kind === "identity")?.id ?? graph.nodes[0].id;

  // BFS to assign a ring (capped at 2 — anything deeper rides on ring 2).
  const ring = new Map<string, number>([[root, 0]]);
  const queue = [root];
  while (queue.length) {
    const id = queue.shift()!;
    const level = ring.get(id)!;
    for (const nb of adj.get(id) ?? []) {
      if (!ring.has(nb)) {
        ring.set(nb, Math.min(level + 1, 2));
        queue.push(nb);
      }
    }
  }
  // Disconnected nodes (no path to root) land on the outer ring.
  for (const n of graph.nodes) if (!ring.has(n.id)) ring.set(n.id, 2);

  const byRing = new Map<number, GraphNode[]>();
  for (const n of graph.nodes) {
    const r = ring.get(n.id)!;
    (byRing.get(r) ?? byRing.set(r, []).get(r)!).push(n);
  }

  for (const [r, nodes] of byRing) {
    if (r === 0) {
      const n = nodes[0];
      out.set(n.id, { ...n, x: CX, y: CY, r: radiusFor(n) });
      continue;
    }
    const radius = RINGS[Math.min(r, RINGS.length - 1)];
    // Offset odd rings by half a step so ring 2 nodes sit between ring 1 spokes.
    const offset = r % 2 === 0 ? 0 : Math.PI / nodes.length;
    nodes.forEach((n, i) => {
      const angle = (i / nodes.length) * Math.PI * 2 - Math.PI / 2 + offset;
      out.set(n.id, {
        ...n,
        x: CX + Math.cos(angle) * radius,
        y: CY + Math.sin(angle) * radius,
        r: radiusFor(n),
      });
    });
  }
  return out;
}

function radiusFor(n: GraphNode): number {
  if (n.kind === "identity") return 26;
  return Math.min(22, 8 + Math.sqrt(Math.max(0, n.degree)) * 3);
}

function strokeFor(timesSeen: number): number {
  return Math.min(4, 1 + Math.sqrt(Math.max(0, timesSeen)) * 0.6);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString([], { month: "short", day: "numeric" });
}
