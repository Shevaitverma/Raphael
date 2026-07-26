"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteFact,
  deleteNote,
  getMemoryGraph,
  type GraphData,
  type GraphEdge,
  type GraphNode,
  type GraphNote,
} from "@/lib/gateway";
import { useAuthed } from "./auth/AuthProvider";

// This view is not an entity explorer over a corpus. It is a portrait of what
// Raphael believes about ONE person, and it exists to answer four questions:
// what do you think you know about me, how sure are you, do you actually use
// it, and how do I remove something wrong. Governance first, spectacle never.

const fmt = (n: number) => n.toLocaleString();
const pct = (c: number) => `${Math.round(c * 100)}%`;

// The stored confidence score, and nothing more. The extractor writes ~0.95 when
// it tags a fact "explicit" AND when it omits the field entirely (a small local
// model routinely omits it), so a high score does NOT prove the user said this —
// it only means nothing marked the fact as inferred. Never render it as "you
// said it": that would be a fabricated citation in the trust indicator itself.
const HIGH_CONF = 0.85;
const highConf = (c: number) => c >= HIGH_CONF;
const confLabel = (c: number) => (highConf(c) ? "high confidence" : "lower confidence");

// What high confidence actually means, said once, everywhere it's needed.
const CONF_HELP =
  "High confidence means the extractor stored this as stated — it isn't proof you said it in these words. Lower confidence means it was marked as inferred.";

// A belief nobody has reinforced in this long reads as stale.
const STALE_DAYS = 90;

// The server returns at most this many episodic notes (read.py NOTES_LIMIT), and
// `truncated` is computed from the FACTS rowcount only — so a full page of notes
// must be labelled as a capped view rather than counted as the total.
const NOTES_CAP = 50;

// Theme tokens, duplicated as hex because SVG paint attributes can't take the
// Tailwind classes. Keep in sync with @theme in globals.css.
const C_PANEL = "#131316";
const C_RAISED = "#1a1a1f";
const C_EDGE = "#26262b";
const C_TEXT = "#e6e6e9";
const C_MUTED = "#8b8b93";
const C_ACCENT = "#4d8eff";

// Fixed viewBox; pan/zoom is a transform on the inner <g>, so the coordinate
// system the sim runs in never changes.
const VB_W = 820;
const VB_H = 520;
const CX = VB_W / 2;
const CY = VB_H / 2;

// Hand-rolled force sim (no dependency; d3-force would pull 4 transitive
// packages for dozens of nodes). O(n²) repulsion + edge springs + gentle
// centering, integrated with damping. Identity node is pinned at center so the
// user stays put.
// Tuned for ~10 spokes around the identity hub: the spring is long enough that a
// predicate label fits at the mid-point, repulsion is strong enough to space the
// ring evenly, and centering is weak enough not to drag everything back into a
// clump (it exists only to keep a disconnected fragment on screen).
const REPULSION = 14000;
const SPRING_LEN = 200;
const SPRING_K = 0.05;
// Centering is elliptical: the canvas is half again as wide as it is tall, so a
// circular layout leaves the sides empty and pushes nodes off the top and
// bottom. Pulling harder in y than in x settles the same graph into an ellipse
// that matches the frame. (Tuned, not derived — 2 reads better than the literal
// 1.58 aspect once labels are counted.)
const CENTER_K = 0.008;
const CENTER_ASPECT = 2;
const DAMPING = 0.9;

// Post-integration separation. NODE_PAD is the gap between two discs; the label
// band is the horizontal strip of text drawn under each node, and two nodes on
// the same line whose bands overlap get pushed apart in x.
const NODE_PAD = 26;
const LABEL_BAND_H = 15;
const LABEL_BAND_W = 92; // ~18 chars at 11px, the node-label truncation width

// The predicate label is the whole relationship, so it is drawn on every edge
// until the canvas would turn to mush. Above this, only the focused edges (and
// the focused node's own edges) keep their label.
const EDGE_LABEL_MAX = 28;

// Persisted view choice — same convention as "raphael.view" in page.tsx.
const MODE_KEY = "raphael.memoryView";
const ARROW_ID = "raphael-memory-arrow";

type Sim = GraphNode & {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number; // force accumulator
  fy: number;
  r: number;
  pinned: boolean; // identity: held at center
  dragging: boolean;
};

// Seeds positions for a graph. `prev` is the previous sim: a node that still
// exists KEEPS its coordinates, a node that vanished is dropped, and only new
// nodes are placed on the ring. Without this, every delete re-randomizes the
// whole map and the user can't tell what actually changed.
function seed(graph: GraphData, prev: Sim[] = []): Sim[] {
  const rootId =
    graph.nodes.find((n) => n.kind === "identity")?.id ?? graph.nodes[0]?.id;
  const old = new Map(prev.map((s) => [s.id, s]));
  const n = Math.max(1, graph.nodes.length);
  return graph.nodes.map((node, i) => {
    const identity = node.id === rootId;
    const a = (i / n) * Math.PI * 2;
    const was = old.get(node.id);
    return {
      ...node,
      // identity is pinned at centre, so it never inherits a stale position —
      // it matters when a delete promotes a DIFFERENT node to identity.
      x: identity ? CX : was?.x ?? CX + Math.cos(a) * 150 + (Math.random() - 0.5) * 40,
      y: identity ? CY : was?.y ?? CY + Math.sin(a) * 150 + (Math.random() - 0.5) * 40,
      vx: 0,
      vy: 0,
      fx: 0,
      fy: 0,
      r: radiusFor(node),
      pinned: identity,
      dragging: false,
    };
  });
}

// One integration step. alpha scales the applied force (d3-style cooling).
// Returns total kinetic energy so the loop knows when to freeze.
function stepSim(sim: Sim[], edges: GraphEdge[], alpha: number): number {
  const byId = new Map(sim.map((s) => [s.id, s]));
  for (const s of sim) {
    s.fx = 0;
    s.fy = 0;
  }
  // repulsion (every pair)
  for (let i = 0; i < sim.length; i++) {
    for (let j = i + 1; j < sim.length; j++) {
      const a = sim[i];
      const b = sim[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) {
        d2 = 0.01;
        dx = 0.1;
        dy = 0;
      }
      const d = Math.sqrt(d2);
      const f = REPULSION / d2;
      const ux = dx / d;
      const uy = dy / d;
      a.fx += ux * f;
      a.fy += uy * f;
      b.fx -= ux * f;
      b.fy -= uy * f;
    }
  }
  // edge springs
  for (const e of edges) {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const f = (d - SPRING_LEN) * SPRING_K;
    const ux = dx / d;
    const uy = dy / d;
    a.fx += ux * f;
    a.fy += uy * f;
    b.fx -= ux * f;
    b.fy -= uy * f;
  }
  // centering + integrate
  let energy = 0;
  for (const s of sim) {
    s.fx += ((CX - s.x) * CENTER_K) / CENTER_ASPECT;
    s.fy += (CY - s.y) * CENTER_K * CENTER_ASPECT;
    if (s.pinned || s.dragging) {
      s.vx = 0;
      s.vy = 0;
      continue;
    }
    s.vx = (s.vx + s.fx * alpha) * DAMPING;
    s.vy = (s.vy + s.fy * alpha) * DAMPING;
    s.x += s.vx;
    s.y += s.vy;
    energy += s.vx * s.vx + s.vy * s.vy;
  }
  separate(sim);
  // Keep everything inside the viewBox, with room under each node for its label.
  for (const s of sim) {
    if (s.pinned || s.dragging) continue;
    s.x = clamp(s.x, s.r + 8, VB_W - s.r - 8);
    s.y = clamp(s.y, s.r + 8, VB_H - s.r - 22);
  }
  return energy;
}

// Position-based separation, run after integration so it can't be overpowered by
// the springs: discs never overlap, and two labels never land on top of each
// other. Positions move, velocities don't, so this can't inject energy.
// ponytail: O(n²) like the repulsion pass above — fine to a few hundred nodes.
function separate(sim: Sim[]): void {
  const shove = (s: Sim, dx: number, dy: number) => {
    if (s.pinned || s.dragging) return false;
    s.x += dx;
    s.y += dy;
    return true;
  };
  for (let i = 0; i < sim.length; i++) {
    for (let j = i + 1; j < sim.length; j++) {
      const a = sim[i];
      const b = sim[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const min = a.r + b.r + NODE_PAD;
      const d = Math.hypot(dx, dy) || 0.01;
      if (d < min) {
        const push = (min - d) / 2;
        const ux = (dx || 0.1) / d;
        const uy = dy / d;
        // If one end can't move (pinned/dragged), the other takes the whole push.
        if (!shove(b, ux * push, uy * push)) shove(a, -ux * push * 2, -uy * push * 2);
        else if (!shove(a, -ux * push, -uy * push)) shove(b, ux * push, uy * push);
      } else if (Math.abs(dy) < LABEL_BAND_H && Math.abs(dx) < LABEL_BAND_W) {
        // Labels would collide side by side: separate horizontally only, and
        // gently — this fights the springs, so a full correction would jitter.
        const push = (LABEL_BAND_W - Math.abs(dx)) * 0.18 * (dx < 0 ? -1 : 1);
        if (!shove(b, push, 0)) shove(a, -push * 2, 0);
        else if (!shove(a, -push, 0)) shove(b, push, 0);
      }
    }
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export default function MemoryGraph({ onNavigate }: { onNavigate: (v: "chat") => void }) {
  const { token, failed: onFail } = useAuthed();
  const qc = useQueryClient();

  const {
    data: graph,
    error,
    isPending,
    refetch,
  } = useQuery({
    queryKey: ["memory", "graph", token],
    queryFn: () => getMemoryGraph(token),
    enabled: !!token,
  });

  // Surface a load failure to the shell — this drives the single-flight token
  // refresh in the auth provider. A token change re-keys the query above.
  useEffect(() => {
    if (error) onFail(error);
  }, [error, onFail]);

  // Forgetting is the whole point of the screen. One mutation for both kinds;
  // per-row "busy" comes from the mutation's variables (Reminders pattern).
  const [delError, setDelError] = useState<string | null>(null);
  const forget = useMutation({
    mutationFn: ({ fn }: { id: string; fn: () => Promise<void> }) => fn(),
    onMutate: () => setDelError(null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["memory"] });
      // The Dashboard's portrait and counters are derived from these facts but
      // sit outside the ["memory"] prefix — without these they keep showing a
      // belief the user just deleted.
      qc.invalidateQueries({ queryKey: ["dashboard", "portrait"] });
      qc.invalidateQueries({ queryKey: ["dashboard", "stats"] });
    },
    onError: (e: unknown) => {
      // The shell's banner lives inside ChatView, which is display:none on this
      // tab — so a failure there is invisible. Show it HERE; still notify the
      // shell so the 401 single-flight token refresh keeps working.
      setDelError(e instanceof Error ? e.message : "Unknown error");
      onFail(e);
    },
  });
  const busy = forget.isPending ? forget.variables?.id ?? null : null;

  // The spatial view is the default: relationships are the thing this screen is
  // for, and only the graph shows them as shape. The list stays one click away —
  // it is still the better read for scanning and for bulk forgetting.
  const [mode, setMode] = useState<"list" | "graph">("graph");
  const [filter, setFilter] = useState<string | null>(null); // isolate one predicate
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const [showNotes, setShowNotes] = useState(true);

  // localStorage doesn't exist during the server render, so read it in an effect
  // (page.tsx does the same for the active tab).
  useEffect(() => {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved === "list" || saved === "graph") setMode(saved);
  }, []);
  useEffect(() => {
    localStorage.setItem(MODE_KEY, mode);
  }, [mode]);

  const edges = useMemo(() => graph?.edges ?? [], [graph]);
  const nodes = graph?.nodes ?? [];
  const notes = graph?.notes ?? [];

  // Predicate is the one real categorical dimension in this data (the payload's
  // only `kind` is identity/entity, which is structure, not category).
  const predicates = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of edges) m.set(e.label, (m.get(e.label) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [edges]);

  // One colour assigner for the whole screen, built from the full predicate set
  // (not the filtered one) so filtering never recolours anything.
  const predColor = useMemo(
    () => makePredColor(predicates.map(([p]) => p)),
    [predicates],
  );

  const shown = useMemo(
    () => (filter ? edges.filter((e) => e.label === filter) : edges),
    [edges, filter],
  );

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // Adjacency for neighbour-highlighting on hover/select.
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const add = (a: string, b: string) =>
      (m.get(a) ?? m.set(a, new Set()).get(a)!).add(b);
    for (const e of shown) {
      add(e.source, e.target);
      add(e.target, e.source);
    }
    return m;
  }, [shown]);

  // Only edges whose recall counter is actually reported and zero. A server that
  // omits access_count must read as "unknown", never as "never recalled".
  const neverUsed = edges.filter((e) => e.access_count === 0).length;
  const recallKnown = edges.some((e) => e.access_count != null);

  const onForgetFact = (e: GraphEdge) =>
    forget.mutate({ id: e.id, fn: () => deleteFact(token, e.id) });
  const onForgetNote = (n: GraphNote) =>
    forget.mutate({ id: n.id, fn: () => deleteNote(token, n.id) });

  if (error && !graph) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8">
        <div className="mx-auto flex max-w-4xl flex-col items-start gap-2 rounded-xl border border-edge bg-panel px-4 py-3">
          <p role="alert" className="text-sm text-error">
            Couldn&apos;t load what Raphael remembers.
          </p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="rounded-md border border-edge bg-raised px-3 py-1 text-xs text-on-surface transition-colors hover:bg-panel"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (isPending || !graph) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8">
        <p className="mx-auto max-w-4xl text-sm text-faint">Loading…</p>
      </div>
    );
  }

  const empty = nodes.length === 0 && notes.length === 0;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8">
      <div className="mx-auto flex max-w-4xl flex-col gap-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl font-semibold text-on-surface">What Raphael knows</h2>
            <p className="mt-1 max-w-xl text-sm text-muted">
              Everything below is used to answer you. If something is wrong, forget it
              here and tell Raphael the right version in chat.
            </p>
          </div>
          {nodes.length > 0 && (
            <div
              role="group"
              aria-label="View"
              className="flex rounded-md border border-edge bg-panel p-0.5 text-sm"
            >
              {(["graph", "list"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  aria-pressed={mode === m}
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
          )}
        </div>

        {delError && (
          <p role="alert" className="border-l-2 border-error bg-error/10 px-3 py-2 text-sm text-error">
            Couldn&apos;t forget that — it is still remembered. {delError}
          </p>
        )}

        {error && (
          <p role="status" className="border-l-2 border-warning bg-warning/10 px-3 py-2 text-sm text-warning">
            Couldn&apos;t refresh — showing the last view that loaded.
          </p>
        )}

        {graph.truncated && (
          <div
            role="status"
            className="border-l-2 border-warning bg-warning/10 px-3 py-2 text-sm text-warning"
          >
            Showing the 200 most-reinforced facts — the counts below cover only those.
          </div>
        )}

        {empty ? (
          <div className="rounded-xl border border-edge bg-panel px-5 py-10 text-center">
            <p className="text-sm text-faint">
              Raphael hasn&apos;t learned anything about you yet. Chat with it and it&apos;ll
              start remembering.
            </p>
            <button
              type="button"
              onClick={() => onNavigate("chat")}
              className="mt-4 rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong"
            >
              Start a chat
            </button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatTile
                label="Things"
                value={fmt(nodes.length)}
                sub="subjects & objects in the facts"
              />
              <StatTile label="Facts" value={fmt(edges.length)} sub="subject → object links" />
              <StatTile
                label="Episodic notes"
                value={notes.length >= NOTES_CAP ? `${fmt(NOTES_CAP)}+` : fmt(notes.length)}
                sub={
                  notes.length >= NOTES_CAP
                    ? `newest ${NOTES_CAP} only`
                    : "remembered moments"
                }
              />
              <StatTile
                label="No recalls yet"
                value={recallKnown ? fmt(neverUsed) : "—"}
                sub={
                  !recallKnown
                    ? "recall counts unavailable"
                    : neverUsed
                      ? "no recorded recall into a reply"
                      : "all have been recalled"
                }
                accent={neverUsed ? "var(--color-warning)" : undefined}
              />
            </div>

            {predicates.length > 0 && (
              <Legend
                predicates={predicates}
                predColor={predColor}
                filter={filter}
                onFilter={(p) => setFilter((f) => (f === p ? null : p))}
              />
            )}

            {mode === "list" ? (
              <Beliefs
                edges={shown}
                nodeById={nodeById}
                predColor={predColor}
                busy={busy}
                onForget={onForgetFact}
              />
            ) : (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_17rem]">
                <Canvas
                  edges={shown}
                  graph={graph}
                  predColor={predColor}
                  neighbors={neighbors}
                  selected={selected}
                  hovered={hovered}
                  selectedEdge={selectedEdge}
                  hoveredEdge={hoveredEdge}
                  onSelect={(id) => {
                    setSelected(id);
                    setSelectedEdge(null);
                  }}
                  onHover={setHovered}
                  onSelectEdge={(id) => {
                    setSelectedEdge(id);
                    setSelected(null);
                  }}
                  onHoverEdge={setHoveredEdge}
                />
                <InspectPanel
                  nodeId={selected}
                  edgeId={selectedEdge}
                  nodeById={nodeById}
                  edges={shown}
                  predColor={predColor}
                  busy={busy}
                  onForget={onForgetFact}
                  onClear={() => {
                    setSelected(null);
                    setSelectedEdge(null);
                  }}
                />
              </div>
            )}
          </>
        )}

        {notes.length > 0 && (
          <div className="rounded-xl border border-edge bg-panel p-4">
            <button
              type="button"
              onClick={() => setShowNotes((s) => !s)}
              className="flex w-full items-center justify-between text-left text-sm font-medium text-on-surface"
              aria-expanded={showNotes}
            >
              <span>
                Moments Raphael remembers (
                {notes.length >= NOTES_CAP ? `newest ${fmt(NOTES_CAP)}` : fmt(notes.length)})
              </span>
              <span className="text-muted" aria-hidden="true">
                {showNotes ? "–" : "+"}
              </span>
            </button>
            {showNotes && (
              <ul className="mt-3 flex flex-col divide-y divide-edge">
                {notes.map((note) => (
                  <li
                    key={note.id}
                    className={`flex items-start gap-3 py-2 text-sm ${
                      busy === note.id ? "opacity-40" : ""
                    }`}
                  >
                    <span className="min-w-0 flex-1 text-on-surface">{note.content}</span>
                    <Tag
                      tone={highConf(note.confidence) ? "muted" : "warning"}
                      title={CONF_HELP}
                    >
                      {highConf(note.confidence) ? "high" : "lower"} conf {pct(note.confidence)}
                    </Tag>
                    <Forget
                      what={note.content}
                      busy={busy === note.id}
                      onConfirm={() => onForgetNote(note)}
                    />
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

// --- stat tiles + chips --------------------------------------------------------

function StatTile({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
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
      {sub && <p className="mt-0.5 truncate text-[11px] text-muted">{sub}</p>}
    </div>
  );
}

function Tag({
  children,
  tone = "muted",
  dotted,
  title,
}: {
  children: React.ReactNode;
  tone?: "muted" | "warning" | "faint";
  dotted?: boolean;
  title?: string;
}) {
  const color =
    tone === "warning"
      ? "var(--color-warning)"
      : tone === "faint"
        ? "var(--color-faint)"
        : "var(--color-muted)";
  return (
    <span
      title={title}
      className="shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
      style={{
        color,
        border: `1px ${dotted ? "dashed" : "solid"} color-mix(in srgb, ${color} 40%, transparent)`,
      }}
    >
      {children}
    </span>
  );
}

// --- legend / filter -----------------------------------------------------------

function Legend({
  predicates,
  predColor,
  filter,
  onFilter,
}: {
  predicates: [string, number][];
  predColor: (p: string) => string;
  filter: string | null;
  onFilter: (p: string) => void;
}) {
  return (
    <div className="rounded-xl border border-edge bg-panel p-3">
      <div className="flex flex-wrap gap-1.5">
        {predicates.map(([p, n]) => {
          const on = filter === p;
          const c = predColor(p);
          return (
            <button
              key={p}
              type="button"
              onClick={() => onFilter(p)}
              aria-pressed={on}
              className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors"
              style={{
                borderColor: on ? c : C_EDGE,
                backgroundColor: on ? `${c}1f` : "transparent",
                color: on ? c : "var(--color-muted)",
              }}
            >
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: c }}
              />
              {p}
              <span className="tabular-nums opacity-70">{n}</span>
            </button>
          );
        })}
        {filter && (
          <button
            type="button"
            onClick={() => onFilter(filter)}
            className="rounded-full px-2.5 py-1 text-xs text-faint underline underline-offset-2 hover:text-on-surface"
          >
            show all
          </button>
        )}
      </div>
      <p className="mt-2.5 text-[11px] leading-relaxed text-faint">
        Colour is the relationship — this legend is the key, so a colour never has to
        be read on its own. A <span className="text-muted">solid</span> bar is{" "}
        <span className="text-muted">high confidence</span>, a{" "}
        <span className="text-warning">dashed</span> one is lower. {CONF_HELP} “No recalls”
        = nothing has been recorded as recalling it into a reply. “Stale” = nothing has
        reinforced it in {STALE_DAYS} days.
      </p>
    </div>
  );
}

// --- the default view: beliefs grouped by predicate ----------------------------

function Beliefs({
  edges,
  nodeById,
  predColor,
  busy,
  onForget,
}: {
  edges: GraphEdge[];
  nodeById: Map<string, GraphNode>;
  predColor: (p: string) => string;
  busy: string | null;
  onForget: (e: GraphEdge) => void;
}) {
  const groups = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    const g = groups.get(e.label) ?? [];
    g.push(e);
    groups.set(e.label, g);
  }
  const label = (id: string) => nodeById.get(id)?.label ?? id;

  return (
    <div className="flex flex-col gap-3">
      {[...groups.entries()].map(([predicate, es]) => {
        const c = predColor(predicate);
        return (
          <section key={predicate} className="rounded-xl border border-edge bg-panel p-4">
            <h3 className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-faint">
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: c }}
              />
              {predicate}
              <span className="tabular-nums">({fmt(es.length)})</span>
            </h3>
            <ul className="mt-2 flex flex-col divide-y divide-edge">
              {es.map((e) => (
                <FactRow
                  key={e.id}
                  edge={e}
                  color={c}
                  subject={label(e.source)}
                  object={label(e.target)}
                  busy={busy === e.id}
                  onForget={() => onForget(e)}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function FactRow({
  edge: e,
  color,
  subject,
  object,
  busy,
  onForget,
}: {
  edge: GraphEdge;
  color: string;
  subject: string;
  object: string;
  busy: boolean;
  onForget: () => void;
}) {
  const high = highConf(e.confidence);
  const age = ageDays(e.last_seen);
  const stale = age != null && age > STALE_DAYS;
  return (
    <li
      className={`flex items-start gap-3 py-2 pl-3 text-sm ${busy ? "opacity-40" : ""}`}
      // Solid = high confidence, dashed = lower. This is the stored score, not a
      // claim about who said it — see CONF_HELP.
      style={{ borderLeft: `2px ${high ? "solid" : "dashed"} ${color}` }}
    >
      <div className="min-w-0 flex-1">
        <p className={stale ? "text-muted" : "text-on-surface"}>
          <span className="font-medium">{subject}</span>{" "}
          <span className="text-muted">{e.label}</span>{" "}
          <span className={high ? "font-medium" : "font-medium italic"}>{object}</span>
        </p>
        <p className="mt-0.5 text-[11px] text-muted">
          <span title={CONF_HELP}>
            {confLabel(e.confidence)} ({pct(e.confidence)})
          </span>{" "}
          · reinforced {fmt(e.times_seen)}×
          {e.access_count ? ` · recalled ${fmt(e.access_count)}×` : ""}
          {e.last_seen ? ` · last ${shortDate(e.last_seen)}` : ""}
        </p>
      </div>
      {e.access_count === 0 && (
        <Tag tone="warning" dotted title="No recall into a reply has been recorded for this fact.">
          no recalls
        </Tag>
      )}
      {stale && <Tag tone="faint">stale</Tag>}
      <Forget what={`${subject} ${e.label} ${object}`} busy={busy} onConfirm={onForget} />
    </li>
  );
}

// --- the delete affordance -----------------------------------------------------
// Two-step and unmistakable: the row's own text turns into the warning, and the
// confirming button is the only red thing on screen. Both steps are real
// <button>s, so the whole loop is keyboard reachable.

function Forget({
  what,
  busy,
  onConfirm,
}: {
  what: string;
  busy: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const trashRef = useRef<HTMLButtonElement>(null);
  const first = useRef(true);

  // Focus moves to the SAFE control on arm (a <button> fires on Enter, so
  // autofocusing "Forget" would let two Enters destroy a belief with focus never
  // resting anywhere safe), and back to the trash icon on cancel. The `first`
  // guard keeps page load from stealing focus into every row.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    (armed ? keepRef : trashRef).current?.focus();
  }, [armed]);

  if (armed) {
    return (
      <span
        role="group"
        aria-label={`Confirm forgetting: ${what}`}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            setArmed(false);
          }
        }}
        className="flex shrink-0 items-center gap-1.5"
      >
        <span role="alert" className="text-[11px] text-error">
          Forget permanently?
        </span>
        <button
          type="button"
          ref={keepRef}
          onClick={() => setArmed(false)}
          aria-label={`Keep: ${what}`}
          className="rounded-md border border-edge px-2 py-0.5 text-[11px] text-muted transition-colors hover:text-on-surface"
        >
          Keep
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setArmed(false);
            onConfirm();
          }}
          aria-label={`Forget permanently: ${what}`}
          className="rounded-md bg-error px-2 py-0.5 text-[11px] font-medium text-surface transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          Forget
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      ref={trashRef}
      disabled={busy}
      onClick={() => setArmed(true)}
      aria-label={`Forget: ${what}`}
      title="Forget this"
      className="shrink-0 rounded-md p-1 text-faint transition-colors hover:bg-raised hover:text-error focus-visible:text-error disabled:opacity-40"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-3.5 w-3.5"
        aria-hidden="true"
      >
        <path d="M3 6h18" />
        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        <path d="M6 6v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6" />
        <path d="M10 11v6M14 11v6" />
      </svg>
    </button>
  );
}

// --- the spatial view ----------------------------------------------------------
// Same force sim as before, calm styling: no grid, no scanline, no glow filters,
// no reticle. Colour carries the predicate, dashes carry "inferred", width
// carries reinforcement. The only motion left is the layout settling.

function Canvas({
  edges,
  graph,
  predColor,
  neighbors,
  selected,
  hovered,
  selectedEdge,
  hoveredEdge,
  onSelect,
  onHover,
  onSelectEdge,
  onHoverEdge,
}: {
  edges: GraphEdge[];
  graph: GraphData;
  predColor: (p: string) => string;
  neighbors: Map<string, Set<string>>;
  selected: string | null;
  hovered: string | null;
  selectedEdge: string | null;
  hoveredEdge: string | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  onSelectEdge: (id: string | null) => void;
  onHoverEdge: (id: string | null) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const simRef = useRef<Sim[]>([]);
  const alphaRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const gestureRef = useRef<
    | { mode: "node"; id: string }
    | { mode: "pan"; startX: number; startY: number; ox: number; oy: number }
    | null
  >(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [, tick] = useReducer((c: number) => c + 1, 0);

  // Honour prefers-reduced-motion: when reduced, the sim is run to convergence
  // once (synchronously) and never animated — no RAF, no in-flight motion.
  const [motion, setMotion] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setMotion(!mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  const reheat = useCallback(() => {
    if (!motion) return;
    alphaRef.current = Math.max(alphaRef.current, 0.6);
    if (rafRef.current != null) return;
    const loop = () => {
      stepSim(simRef.current, graph.edges, alphaRef.current);
      alphaRef.current *= 0.985;
      tick();
      if (alphaRef.current > 0.02 || gestureRef.current?.mode === "node") {
        rafRef.current = requestAnimationFrame(loop);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [motion, graph]);

  // (Re)seed and settle whenever the data or the motion preference changes.
  // Note it keys on the whole graph, not the filtered edges: filtering hides
  // links, it must not rearrange the layout under the user. Seeding carries the
  // previous positions forward, so a refetch after a delete moves only what
  // actually changed instead of reshuffling the whole map.
  useEffect(() => {
    if (graph.nodes.length === 0) return;
    simRef.current = seed(graph, simRef.current);
    if (!motion) {
      for (let i = 0; i < 300; i++) stepSim(simRef.current, graph.edges, 0.4);
      tick();
      return;
    }
    reheat();
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, motion]);

  // clientX/Y -> viewBox coords (no rotation/skew, so a/d + e/f suffice).
  const toVB = useCallback((clientX: number, clientY: number) => {
    const ctm = svgRef.current?.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    return { x: (clientX - ctm.e) / ctm.a, y: (clientY - ctm.f) / ctm.d };
  }, []);

  // Non-passive wheel so preventDefault actually blocks page scroll. Zoom keeps
  // the point under the cursor fixed.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const h = (e: WheelEvent) => {
      e.preventDefault();
      const p = toVB(e.clientX, e.clientY);
      setView((v) => {
        const k = clamp(v.k * (e.deltaY < 0 ? 1.12 : 0.9), 0.35, 3);
        const gx = (p.x - v.x) / v.k;
        const gy = (p.y - v.y) / v.k;
        return { k, x: p.x - gx * k, y: p.y - gy * k };
      });
    };
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, [toVB]);

  const onDownNode = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    svgRef.current?.setPointerCapture(e.pointerId);
    const s = simRef.current.find((s) => s.id === id);
    if (s) s.dragging = true;
    gestureRef.current = { mode: "node", id };
    reheat();
  };

  const onDownBg = (e: React.PointerEvent) => {
    svgRef.current?.setPointerCapture(e.pointerId);
    const p = toVB(e.clientX, e.clientY);
    gestureRef.current = { mode: "pan", startX: p.x, startY: p.y, ox: view.x, oy: view.y };
  };

  const onMove = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (!g) return;
    const p = toVB(e.clientX, e.clientY);
    if (g.mode === "node") {
      const s = simRef.current.find((s) => s.id === g.id);
      if (s) {
        s.x = (p.x - view.x) / view.k;
        s.y = (p.y - view.y) / view.k;
      }
      if (motion) reheat();
      else tick();
    } else {
      setView((v) => ({ ...v, x: g.ox + (p.x - g.startX), y: g.oy + (p.y - g.startY) }));
    }
  };

  const onUp = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (g?.mode === "node") {
      const s = simRef.current.find((s) => s.id === g.id);
      if (s) s.dragging = false;
      reheat();
    }
    gestureRef.current = null;
    svgRef.current?.releasePointerCapture?.(e.pointerId);
  };

  const pos = new Map(simRef.current.map((s) => [s.id, s]));
  const activeId = hovered ?? selected;
  const activeEdgeId = hoveredEdge ?? selectedEdge;
  const focusEdge = activeEdgeId ? edges.find((e) => e.id === activeEdgeId) : undefined;
  const anyFocus = activeId != null || focusEdge != null;
  // Only nodes still touched by a visible link are drawn — filtering to one
  // predicate must not leave a field of orphans.
  const visible = new Set<string>();
  for (const e of edges) {
    visible.add(e.source);
    visible.add(e.target);
  }
  const showAllLabels = edges.length <= EDGE_LABEL_MAX;
  const fade = motion ? "opacity 160ms ease" : undefined;

  // Edge geometry, computed once and shared by the stroke, the hit area and the
  // label: endpoints trimmed to the node rims so the arrowhead lands on the
  // target's edge instead of under its disc.
  const laid = edges.flatMap((e) => {
    const a = pos.get(e.source);
    const b = pos.get(e.target);
    if (!a || !b) return [];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d;
    const uy = dy / d;
    const x1 = a.x + ux * (a.r + 1);
    const y1 = a.y + uy * (a.r + 1);
    const x2 = b.x - ux * (b.r + 9);
    const y2 = b.y - uy * (b.r + 9);
    // Keep the label upright: past vertical, flip it end-for-end.
    let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (deg > 90 || deg < -90) deg += 180;
    const active = activeId === e.source || activeId === e.target || e.id === activeEdgeId;
    return [{ e, x1, y1, x2, y2, mx: (x1 + x2) / 2, my: (y1 + y2) / 2, deg, span: d - a.r - b.r, active }];
  });

  return (
    <div className="overflow-hidden rounded-xl border border-edge bg-panel">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        role="img"
        aria-label={`Knowledge graph: ${fmt(graph.nodes.length)} things joined by ${fmt(edges.length)} facts, each arrow labelled with its relationship and pointing from subject to object. The list view is the readable equivalent.`}
        className="w-full touch-none select-none"
        style={{ cursor: gestureRef.current?.mode === "pan" ? "grabbing" : "grab" }}
        onPointerDown={onDownBg}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {/* One arrowhead for the whole canvas, sized in user units so a thick
            (heavily reinforced) edge doesn't get a giant head. */}
        <defs>
          <marker
            id={ARROW_ID}
            viewBox="0 0 10 10"
            refX={9}
            refY={5}
            markerWidth={9}
            markerHeight={9}
            markerUnits="userSpaceOnUse"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10 Z" fill={C_MUTED} />
          </marker>
        </defs>

        {/* Full-canvas hit area so a pointerdown on empty space pans. */}
        <rect x={0} y={0} width={VB_W} height={VB_H} fill={C_PANEL} />

        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {laid.map(({ e, x1, y1, x2, y2, active }) => (
            <line
              key={e.id}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={predColor(e.label)}
              // opacity, not stroke-opacity: it has to carry the marker too.
              opacity={active ? 0.95 : anyFocus ? 0.12 : 0.55}
              strokeWidth={strokeFor(e.times_seen)}
              strokeLinecap="round"
              // dashed = lower stored confidence, same encoding as the list
              strokeDasharray={highConf(e.confidence) ? undefined : "5 4"}
              markerEnd={`url(#${ARROW_ID})`}
              pointerEvents="none"
              style={{ transition: fade }}
            />
          ))}

          {/* Fat invisible strokes: an edge is a click target too, so a fact can
              be inspected (and forgotten) without going via one of its nodes. */}
          {laid.map(({ e, x1, y1, x2, y2 }) => (
            <line
              key={e.id}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="transparent"
              strokeWidth={14}
              pointerEvents="stroke"
              className="cursor-pointer"
              onPointerDown={(ev) => ev.stopPropagation()}
              onPointerEnter={() => onHoverEdge(e.id)}
              onPointerLeave={() => onHoverEdge(null)}
              onClick={() => onSelectEdge(e.id)}
            />
          ))}

          {/* The predicate IS the fact. Drawn along the edge, in the edge's
              colour, with a halo so it stays legible where lines cross. */}
          {laid.map(({ e, mx, my, deg, span, active }) => {
            if (!active && !showAllLabels) return null;
            if (span < 34) return null; // no room; hover the edge to read it
            return (
              <text
                key={e.id}
                x={mx}
                y={my}
                transform={`rotate(${deg.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)})`}
                dy={-4}
                textAnchor="middle"
                fontSize={9.5}
                className="pointer-events-none"
                fill={predColor(e.label)}
                opacity={active ? 1 : anyFocus ? 0.25 : 0.9}
                style={{ paintOrder: "stroke", stroke: C_PANEL, strokeWidth: 3.5 }}
              >
                {truncate(e.label, Math.max(4, Math.floor(span / 6)))}
              </text>
            );
          })}

          {simRef.current.map((s) => {
            if (!visible.has(s.id)) return null;
            const onFocusEdge = focusEdge?.source === s.id || focusEdge?.target === s.id;
            const isActive = activeId === s.id || onFocusEdge;
            const isNeighbor =
              activeId != null && (neighbors.get(activeId)?.has(s.id) ?? false);
            const dim = anyFocus && !isActive && !isNeighbor;
            const identity = s.kind === "identity";
            const picked = selected === s.id;
            const stroke = picked || identity ? C_ACCENT : C_EDGE;
            return (
              <g
                key={s.id}
                className="cursor-pointer"
                onPointerDown={(e) => onDownNode(e, s.id)}
                onPointerEnter={() => onHover(s.id)}
                onPointerLeave={() => onHover(null)}
                onClick={() => onSelect(s.id)}
                opacity={dim ? 0.3 : 1}
                style={{ transition: fade }}
              >
                <circle
                  cx={s.x}
                  cy={s.y}
                  r={s.r}
                  fill={identity ? "#4d8eff22" : C_RAISED}
                  stroke={stroke}
                  strokeWidth={picked ? 2.5 : 1.25}
                />
                <text
                  x={s.x}
                  y={s.y + s.r + 13}
                  textAnchor="middle"
                  fontSize={11}
                  className="pointer-events-none"
                  fill={picked || identity ? C_TEXT : C_MUTED}
                  style={{ paintOrder: "stroke", stroke: C_PANEL, strokeWidth: 3.5 }}
                >
                  {truncate(s.label, 18)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      <p className="border-t border-edge px-3 py-1.5 text-right text-[11px] text-faint">
        click a node or a labelled arrow to inspect · drag a node · scroll to zoom ·
        drag the canvas to pan
      </p>
    </div>
  );
}

// Right-side panel: the selected node's facts, with the same provenance and the
// same delete affordance as the list. The list view is the readable equivalent.
function InspectPanel({
  nodeId,
  edgeId,
  nodeById,
  edges,
  predColor,
  busy,
  onForget,
  onClear,
}: {
  nodeId: string | null;
  edgeId: string | null;
  nodeById: Map<string, GraphNode>;
  edges: GraphEdge[];
  predColor: (p: string) => string;
  busy: string | null;
  onForget: (e: GraphEdge) => void;
  onClear: () => void;
}) {
  // `edges` is the filtered set, so a selection the filter hid falls back to the
  // prompt rather than showing an empty panel with a stale title.
  const picked = edgeId ? edges.find((e) => e.id === edgeId) : undefined;
  const node = nodeId ? nodeById.get(nodeId) : undefined;
  if (!picked && !node) {
    return (
      <div className="rounded-xl border border-edge bg-panel p-4 text-sm text-faint">
        Click a node or an arrow to see the facts behind it — and to forget any of
        them.
      </div>
    );
  }
  const name = (id: string) => nodeById.get(id)?.label ?? id;
  // Subject and object come from the edge's own direction, never from which end
  // happens to be selected — the arrow on the canvas has to mean what it says.
  const rows = (picked ? [picked] : edges.filter((e) => e.source === nodeId || e.target === nodeId))
    .map((edge) => ({ edge, subject: name(edge.source), object: name(edge.target) }));

  return (
    <div className="rounded-xl border border-edge bg-panel p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-base font-semibold text-on-surface">
          {picked ? `${name(picked.source)} → ${name(picked.target)}` : node?.label}
        </h3>
        <button
          type="button"
          onClick={onClear}
          className="shrink-0 text-xs text-muted hover:text-on-surface"
        >
          Clear
        </button>
      </div>
      <ul className="mt-3 flex flex-col gap-3">
        {rows.length === 0 && <li className="text-sm text-faint">No facts on this node.</li>}
        {rows.map(({ edge, subject, object }) => (
          <FactRow
            key={edge.id}
            edge={edge}
            color={predColor(edge.label)}
            subject={subject}
            object={object}
            busy={busy === edge.id}
            onForget={() => onForget(edge)}
          />
        ))}
      </ul>
    </div>
  );
}

// --- helpers -------------------------------------------------------------------

// Hues spaced by golden angle over the SORTED predicate list, not by a raw hash:
// a hash mod 360 puts two relationships two degrees apart often enough to matter,
// and above EDGE_LABEL_MAX edges the canvas drops the unfocused edge labels, so
// colour would be carrying the meaning alone. Same list -> same colours in both views and across reloads;
// the legend is always rendered, so colour is never the only key.
function makePredColor(predicates: string[]): (p: string) => string {
  const idx = new Map([...predicates].sort().map((p, i) => [p, i]));
  return (p) => `hsl(${(((idx.get(p) ?? idx.size) * 137.508 + 20) % 360).toFixed(1)} 62% 63%)`;
}

function ageDays(iso?: string): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);
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

// --- self-check (runs in dev) ------------------------------------------------
// If the force step breaks, these fail loudly in the console. Invariants:
// overlapping nodes must repel apart, a connected pair must relax toward the
// spring rest length, the sim must settle to ~0 energy, labels must not stack,
// and nothing may end up off-canvas.
function verifySim(): void {
  const mk = (id: string, kind: GraphNode["kind"], x: number, y: number): Sim => ({
    id,
    label: id,
    kind,
    degree: 1,
    x,
    y,
    vx: 0,
    vy: 0,
    fx: 0,
    fy: 0,
    r: 10,
    pinned: false,
    dragging: false,
  });

  // two overlapping, unconnected nodes must push apart and settle
  const a = [mk("a", "entity", CX, CY), mk("b", "entity", CX, CY)];
  for (let i = 0; i < 400; i++) stepSim(a, [], 0.4);
  const sep = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
  console.assert(sep > 20, "repulsion should separate overlapping nodes", sep);
  console.assert(stepSim(a, [], 0.4) < 1, "unconnected pair should settle", sep);

  // a connected pair started far apart should relax near SPRING_LEN
  const c = [mk("a", "entity", CX - 200, CY), mk("b", "entity", CX + 200, CY)];
  const edge: GraphEdge = {
    id: "e1",
    source: "a",
    target: "b",
    label: "rel",
    confidence: 1,
    times_seen: 1,
    access_count: 0,
  };
  for (let i = 0; i < 400; i++) stepSim(c, [edge], 0.4);
  const d = Math.hypot(c[0].x - c[1].x, c[0].y - c[1].y);
  console.assert(Math.abs(d - SPRING_LEN) < SPRING_LEN, "spring should relax near rest length", d);
  // ...and far enough apart for a mid-edge predicate label to be readable.
  console.assert(d > 90, "a linked pair must leave room for an edge label", d);

  // two nodes on the same baseline must slide apart so their labels don't stack
  const lab = [mk("a", "entity", CX - 30, CY), mk("b", "entity", CX + 30, CY + 4)];
  for (let i = 0; i < 60; i++) separate(lab);
  console.assert(
    Math.abs(lab[0].x - lab[1].x) > LABEL_BAND_W - 4 ||
      Math.abs(lab[0].y - lab[1].y) > LABEL_BAND_H,
    "overlapping label bands must separate",
    lab[0].x - lab[1].x,
  );

  // nothing may sit outside the viewBox, whatever the forces did
  const out = [mk("a", "entity", 5000, -400)];
  stepSim(out, [], 0.4);
  console.assert(
    out[0].x <= VB_W - out[0].r - 8 && out[0].y >= out[0].r + 8,
    "nodes must be clamped into the canvas",
    out[0].x,
    out[0].y,
  );

  // colour must be stable for a given predicate set, and well spaced
  const color = makePredColor(["loves", "cooks", "lives in"]);
  const hue = (p: string) => Number(color(p).slice(4, color(p).indexOf(" ")));
  console.assert(color("cooks") === makePredColor(["lives in", "cooks", "loves"])("cooks"),
    "predicate colour must not depend on input order");
  const hues = ["loves", "cooks", "lives in"].map(hue).sort((a, b) => a - b);
  console.assert(
    hues.every((h, i) => i === 0 || h - hues[i - 1] > 30),
    "predicate hues must be spaced, not collide",
    hues,
  );

  // the confidence split, and the layout carried across a refetch
  console.assert(highConf(0.95) && !highConf(0.7), "0.95 is high confidence, 0.70 is lower");
  const g = (ids: string[]): GraphData => ({
    nodes: ids.map((id) => ({ id, label: id, kind: "entity" as const, degree: 1 })),
    edges: [],
    notes: [],
    truncated: false,
  });
  const before = seed(g(["a", "b", "c"]));
  before[2].x = 111; // "c" — not the pinned identity node, which is always centred
  const after = seed(g(["b", "c", "d"]), before);
  console.assert(after.find((s) => s.id === "c")?.x === 111, "a surviving node keeps its position");
  console.assert(after.length === 3 && !after.some((s) => s.id === "a"), "a deleted node is dropped");
}

if (process.env.NODE_ENV !== "production") verifySim();
