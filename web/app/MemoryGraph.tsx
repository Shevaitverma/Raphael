"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  getMemoryGraph,
  type GraphData,
  type GraphEdge,
  type GraphNode,
} from "@/lib/gateway";
import { useAuthed } from "./auth/AuthProvider";

const fmt = (n: number) => n.toLocaleString();
const pct = (c: number) => `${Math.round(c * 100)}%`;

// Fixed viewBox; pan/zoom is a transform on the inner <g>, so the coordinate
// system the sim runs in never changes.
const VB_W = 820;
const VB_H = 560;
const CX = VB_W / 2;
const CY = VB_H / 2;

// --- holographic HUD palette -------------------------------------------------
// Deliberately its own palette (not --color-accent): the graph canvas is a
// heads-up display, everything around it stays on the app's blue/violet tokens.
const CANVAS = "#04070d"; // near-black backdrop, also the label halo colour
const HOLO = "#22d3ee"; // primary cyan
const HOLO_SOFT = "#38bdf8"; // edges / secondary strokes
const HOLO_PALE = "#7dd3fc"; // labels
const LOCK = "#fbbf24"; // selected ("locked on") node

// Cap on simultaneously animated edge pulses — a dense graph must not turn into
// a light show, and 24 travelling dashes is already plenty of life.
const PULSE_CAP = 24;

// One <style> for the whole canvas: every decorative animation is declarative
// CSS (no JS timers, nothing driven from the sim's RAF loop) and every one of
// them is switched off under prefers-reduced-motion, leaving a static — still
// holographic — HUD.
const HUD_CSS = `
/* --mg-lo/--mg-hi are set per node so the pulse keeps each node's own
   brightness (lit vs. resting) instead of flattening them all to one value. */
@keyframes mg-halo { 0%,100% { opacity:var(--mg-lo,.3); transform:scale(.9); } 50% { opacity:var(--mg-hi,.6); transform:scale(1.1); } }
@keyframes mg-dash { to { stroke-dashoffset:-64; } }
@keyframes mg-spin { to { transform:rotate(360deg); } }
@keyframes mg-spin-rev { to { transform:rotate(-360deg); } }
@keyframes mg-sweep { 0%,72% { transform:translateX(-160px); opacity:0; } 74% { opacity:.5; } 96% { opacity:.5; } 100% { transform:translateX(${VB_W}px); opacity:0; } }
@keyframes mg-in { from { opacity:0; transform:scale(.55); } }
/* rotate/scale about the element's own centre, not the viewBox origin */
.mg-o { transform-box:fill-box; transform-origin:center; }
.mg-halo { animation:mg-halo 5.5s ease-in-out infinite; }
.mg-dash { animation:mg-dash 3.4s linear infinite; }
.mg-spin { animation:mg-spin 7s linear infinite; }
.mg-spin-rev { animation:mg-spin-rev 11s linear infinite; }
.mg-sweep { animation:mg-sweep 11s linear infinite; }
.mg-in { animation:mg-in 480ms cubic-bezier(.2,.8,.3,1) backwards; }
@media (prefers-reduced-motion: reduce) {
  .mg-halo,.mg-dash,.mg-spin,.mg-spin-rev,.mg-in { animation:none; }
  .mg-sweep { display:none; }
}
`;

// Hand-rolled force sim (no dependency; d3-force would pull 4 transitive
// packages for dozens of nodes). O(n²) repulsion + edge springs + gentle
// centering, integrated with damping. Identity node is pinned at center so the
// user stays put.
const REPULSION = 6000;
const SPRING_LEN = 90;
const SPRING_K = 0.06;
const CENTER_K = 0.02;
const DAMPING = 0.9;

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

function seed(graph: GraphData): Sim[] {
  const rootId =
    graph.nodes.find((n) => n.kind === "identity")?.id ?? graph.nodes[0]?.id;
  const n = Math.max(1, graph.nodes.length);
  return graph.nodes.map((node, i) => {
    const identity = node.id === rootId;
    const a = (i / n) * Math.PI * 2;
    return {
      ...node,
      x: identity ? CX : CX + Math.cos(a) * 150 + (Math.random() - 0.5) * 40,
      y: identity ? CY : CY + Math.sin(a) * 150 + (Math.random() - 0.5) * 40,
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
    s.fx += (CX - s.x) * CENTER_K;
    s.fy += (CY - s.y) * CENTER_K;
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
  return energy;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export default function MemoryGraph({ onNavigate }: { onNavigate: (v: "chat") => void }) {
  const { token, failed: onFail } = useAuthed();
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

  // --- force sim + interaction plumbing --------------------------------------
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

  const reheat = useCallback(() => {
    if (!motion) return;
    alphaRef.current = Math.max(alphaRef.current, 0.6);
    if (rafRef.current != null) return;
    const loop = () => {
      stepSim(simRef.current, graph?.edges ?? [], alphaRef.current);
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
  useEffect(() => {
    if (!graph || graph.nodes.length === 0) return;
    simRef.current = seed(graph);
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
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
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
  const pos = new Map(simRef.current.map((s) => [s.id, s]));
  // Showing every edge label at once is noise past a couple dozen edges; below
  // that show them all, above it show them only for the active node.
  const showAllLabels = graph.edges.length <= 22;
  // Past ~60 nodes the decorative layer gets scaled back: haloes only on the
  // nodes you're looking at, and no edge pulses at all.
  const heavy = graph.nodes.length > 60;

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
            <div
              className="relative overflow-hidden rounded-xl border"
              style={{
                background: `radial-gradient(120% 90% at 50% 40%, #0a1420 0%, ${CANVAS} 70%)`,
                borderColor: "rgba(34,211,238,0.22)",
                boxShadow: "inset 0 0 60px -20px rgba(34,211,238,0.35)",
              }}
            >
              <style>{HUD_CSS}</style>
              <svg
                ref={svgRef}
                viewBox={`0 0 ${VB_W} ${VB_H}`}
                role="img"
                aria-label={`knowledge graph, ${fmt(graph.edges.length)} facts`}
                className="w-full touch-none select-none"
                style={{ cursor: gestureRef.current?.mode === "pan" ? "grabbing" : "grab" }}
                onPointerDown={onDownBg}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={onUp}
              >
                {/* One shared set of defs for the whole canvas: gradients, the
                    grid pattern and exactly two blur filters, referenced by id.
                    Never a filter per node. */}
                <defs>
                  <radialGradient id="mg-core" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor={HOLO_PALE} stopOpacity="0.75" />
                    <stop offset="45%" stopColor={HOLO} stopOpacity="0.35" />
                    <stop offset="100%" stopColor={HOLO} stopOpacity="0" />
                  </radialGradient>
                  <radialGradient id="mg-lock" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor={LOCK} stopOpacity="0.8" />
                    <stop offset="45%" stopColor={LOCK} stopOpacity="0.35" />
                    <stop offset="100%" stopColor={LOCK} stopOpacity="0" />
                  </radialGradient>
                  <linearGradient id="mg-scan" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor={HOLO} stopOpacity="0" />
                    <stop offset="80%" stopColor={HOLO} stopOpacity="0.12" />
                    <stop offset="100%" stopColor={HOLO_PALE} stopOpacity="0.5" />
                  </linearGradient>
                  <pattern id="mg-grid" width="41" height="40" patternUnits="userSpaceOnUse">
                    <path
                      d="M41 0H0V40"
                      fill="none"
                      stroke={HOLO}
                      strokeOpacity="0.075"
                      strokeWidth="0.6"
                    />
                  </pattern>
                  <filter id="mg-glow" x="-120%" y="-120%" width="340%" height="340%">
                    <feGaussianBlur stdDeviation="2.6" result="b" />
                    <feMerge>
                      <feMergeNode in="b" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                  <filter id="mg-glow-hot" x="-150%" y="-150%" width="400%" height="400%">
                    <feGaussianBlur stdDeviation="5" result="b" />
                    <feMerge>
                      <feMergeNode in="b" />
                      <feMergeNode in="b" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                </defs>

                {/* ---- HUD chrome: fixed to the canvas, outside pan/zoom ---- */}
                <g aria-hidden="true" className="pointer-events-none">
                  <rect x={0} y={0} width={VB_W} height={VB_H} fill="url(#mg-grid)" />
                  <rect
                    className="mg-sweep"
                    x={0}
                    y={0}
                    width={160}
                    height={VB_H}
                    fill="url(#mg-scan)"
                  />
                  {/* corner brackets */}
                  {[
                    [14, 14, 1, 1],
                    [VB_W - 14, 14, -1, 1],
                    [14, VB_H - 14, 1, -1],
                    [VB_W - 14, VB_H - 14, -1, -1],
                  ].map(([x, y, sx, sy], i) => (
                    <path
                      key={i}
                      d={`M${x + sx * 30} ${y} H${x} V${y + sy * 30}`}
                      fill="none"
                      stroke={HOLO}
                      strokeOpacity="0.45"
                      strokeWidth="1.5"
                    />
                  ))}
                </g>

                {/* Full-canvas hit area so a pointerdown on empty space pans. */}
                <rect x={0} y={0} width={VB_W} height={VB_H} fill="transparent" />

                <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
                  {/* ---- edges: thin luminous lines + travelling data pulses ---- */}
                  {graph.edges.map((e, i) => {
                    const a = pos.get(e.source);
                    const b = pos.get(e.target);
                    if (!a || !b) return null;
                    const active = activeId === e.source || activeId === e.target;
                    const dim = activeId != null && !active;
                    // Sparse by design: only the first PULSE_CAP edges carry a
                    // pulse, none on a heavy graph, and none on dimmed edges.
                    const pulse = !heavy && i < PULSE_CAP && !dim;
                    return (
                      <g key={i}>
                        <line
                          x1={a.x}
                          y1={a.y}
                          x2={b.x}
                          y2={b.y}
                          stroke={active ? HOLO_PALE : HOLO_SOFT}
                          strokeOpacity={active ? 0.85 : dim ? 0.05 : 0.22}
                          strokeWidth={strokeFor(e.times_seen)}
                          style={{ transition: "stroke-opacity 200ms ease" }}
                        />
                        {pulse && (
                          <line
                            className="mg-dash"
                            x1={a.x}
                            y1={a.y}
                            x2={b.x}
                            y2={b.y}
                            stroke={HOLO_PALE}
                            strokeOpacity={active ? 0.95 : 0.4}
                            strokeWidth={Math.min(2.4, strokeFor(e.times_seen) + 0.4)}
                            strokeLinecap="round"
                            strokeDasharray="3 61"
                            style={{ animationDelay: `${(i % 8) * 420}ms` }}
                          />
                        )}
                      </g>
                    );
                  })}

                  {/* ---- edge labels ---- */}
                  {graph.edges.map((e, i) => {
                    const a = pos.get(e.source);
                    const b = pos.get(e.target);
                    if (!a || !b) return null;
                    const active = activeId === e.source || activeId === e.target;
                    if (!active && !showAllLabels) return null;
                    return (
                      <text
                        key={i}
                        x={(a.x + b.x) / 2}
                        y={(a.y + b.y) / 2}
                        textAnchor="middle"
                        fontSize={9}
                        className="pointer-events-none"
                        fill={active ? "#dff4ff" : "#6f8ea3"}
                        opacity={active ? 1 : 0.75}
                        style={{
                          fontFamily: "ui-monospace, monospace",
                          letterSpacing: "0.04em",
                          paintOrder: "stroke",
                          stroke: CANVAS,
                          strokeWidth: 3.5,
                        }}
                      >
                        {e.label}
                      </text>
                    );
                  })}

                  {/* ---- nodes ---- */}
                  {simRef.current.map((s, i) => {
                    const isActive = activeId === s.id;
                    const isNeighbor =
                      activeId != null && (neighbors.get(activeId)?.has(s.id) ?? false);
                    const dim = activeId != null && !isActive && !isNeighbor;
                    const lit = isActive || isNeighbor || selected === s.id;
                    const identity = s.kind === "identity";
                    const locked = selected === s.id; // "lock on" target
                    const ring = locked ? LOCK : identity ? HOLO_PALE : HOLO;
                    return (
                      <g
                        key={s.id}
                        className="mg-in mg-o cursor-pointer"
                        onPointerDown={(e) => onDownNode(e, s.id)}
                        onPointerEnter={() => setHovered(s.id)}
                        onPointerLeave={() => setHovered(null)}
                        onClick={() => setSelected(s.id)}
                        opacity={dim ? 0.22 : 1}
                        // Entrance stagger; cycled so a big graph still lands fast.
                        style={{
                          transition: "opacity 200ms ease",
                          animationDelay: `${(i % 24) * 35}ms`,
                        }}
                      >
                        {/* soft pulsing halo — staggered so nothing breathes in unison */}
                        {(identity || lit || !heavy) && (
                          <circle
                            className="mg-o mg-halo"
                            cx={s.x}
                            cy={s.y}
                            r={s.r * (identity ? 2.4 : 1.9)}
                            fill={locked ? "url(#mg-lock)" : "url(#mg-core)"}
                            // attribute = the reduced-motion resting value
                            opacity={identity ? 0.85 : lit ? 0.6 : 0.32}
                            style={
                              {
                                "--mg-lo": identity ? 0.6 : lit ? 0.42 : 0.22,
                                "--mg-hi": identity ? 1 : lit ? 0.8 : 0.42,
                                animationDelay: `${(i % 9) * 640}ms`,
                              } as React.CSSProperties
                            }
                          />
                        )}
                        {/* concentric ring */}
                        <circle
                          cx={s.x}
                          cy={s.y}
                          r={s.r + 5}
                          fill="none"
                          stroke={ring}
                          strokeOpacity={lit ? 0.55 : 0.25}
                          strokeWidth={1}
                          strokeDasharray="3 6"
                        />
                        {/* lock-on reticle: counter-rotating rings + bracket ticks */}
                        {locked && (
                          <>
                            <circle
                              className="mg-o mg-spin"
                              cx={s.x}
                              cy={s.y}
                              r={s.r + 12}
                              fill="none"
                              stroke={LOCK}
                              strokeOpacity={0.9}
                              strokeWidth={1.4}
                              strokeDasharray="16 12"
                            />
                            <circle
                              className="mg-o mg-spin-rev"
                              cx={s.x}
                              cy={s.y}
                              r={s.r + 18}
                              fill="none"
                              stroke={LOCK}
                              strokeOpacity={0.45}
                              strokeWidth={1}
                              strokeDasharray="2 10"
                            />
                            {[
                              [-1, -1],
                              [1, -1],
                              [-1, 1],
                              [1, 1],
                            ].map(([sx, sy], k) => {
                              const d = s.r + 22;
                              return (
                                <path
                                  key={k}
                                  d={`M${s.x + sx * d} ${s.y + sy * (d - 7)} V${s.y + sy * d} H${s.x + sx * (d - 7)}`}
                                  fill="none"
                                  stroke={LOCK}
                                  strokeOpacity={0.85}
                                  strokeWidth={1.4}
                                />
                              );
                            })}
                          </>
                        )}
                        <circle
                          cx={s.x}
                          cy={s.y}
                          r={s.r}
                          fill={identity ? "rgba(34,211,238,0.22)" : "rgba(8,20,32,0.9)"}
                          stroke={ring}
                          strokeWidth={identity ? 2.5 : lit ? 2 : 1.25}
                          strokeOpacity={lit || identity ? 1 : 0.6}
                          filter={locked ? "url(#mg-glow-hot)" : lit ? "url(#mg-glow)" : undefined}
                          style={{ transition: "stroke 200ms ease" }}
                        />
                        {/* Labels sit outside the glow filter and keep a solid
                            backdrop stroke, so nothing smears them. */}
                        <text
                          x={s.x}
                          y={s.y + s.r + 13}
                          textAnchor="middle"
                          fontSize={11}
                          className="pointer-events-none"
                          fill={locked ? LOCK : lit || identity ? "#eaf8ff" : "#9db4c4"}
                          style={{
                            fontFamily: "ui-monospace, monospace",
                            letterSpacing: "0.03em",
                            paintOrder: "stroke",
                            stroke: CANVAS,
                            strokeWidth: 3.5,
                          }}
                        >
                          {truncate(s.label, 18)}
                        </text>
                      </g>
                    );
                  })}
                </g>
              </svg>
              {/* HUD readouts */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute left-5 top-3 font-mono text-[10px] uppercase tracking-[0.18em]"
                style={{ color: "rgba(125,211,252,0.7)" }}
              >
                nodes {fmt(graph.nodes.length)} · links {fmt(graph.edges.length)}
              </div>
              <div
                aria-hidden="true"
                className="pointer-events-none absolute right-5 top-3 max-w-[45%] truncate font-mono text-[10px] uppercase tracking-[0.18em]"
                style={{ color: selected ? LOCK : "rgba(125,211,252,0.55)" }}
              >
                {selected
                  ? `◈ lock ${truncate(nodeById.get(selected)?.label ?? selected, 22)}`
                  : "◇ standby"}
              </div>
              <div
                className="pointer-events-none absolute bottom-3 right-5 font-mono text-[10px] tracking-wider"
                style={{ color: "rgba(125,211,252,0.45)" }}
              >
                drag node · scroll zoom · drag canvas to pan
              </div>
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
// spring rest length, and the sim must settle to ~0 energy.
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
  const edge: GraphEdge = { source: "a", target: "b", label: "rel", confidence: 1, times_seen: 1 };
  for (let i = 0; i < 400; i++) stepSim(c, [edge], 0.4);
  const d = Math.hypot(c[0].x - c[1].x, c[0].y - c[1].y);
  console.assert(Math.abs(d - SPRING_LEN) < SPRING_LEN, "spring should relax near rest length", d);
}

if (process.env.NODE_ENV !== "production") verifySim();
