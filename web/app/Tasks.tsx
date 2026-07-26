"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  createTask,
  deleteTask,
  getTasks,
  updateTask,
  type Task,
} from "@/lib/gateway";
import { useAuthed } from "./auth/AuthProvider";
import {
  levelForXp,
  questXp,
  rankForLevel,
  totalXp,
  XP_BY_PRIORITY,
} from "@/lib/quests";

// The board's three columns, left to right. `status` is the frozen contract
// value the API stores; the rest is presentation. `dot` tints the column's
// status marker; `tint` is the drag-over wash. UI language is "quest"; the
// stored status stays open|in_progress|done — never rename the contract.
const COLUMNS = [
  { status: "open", label: "To Do", dot: "bg-faint", tint: "bg-raised/60" },
  { status: "in_progress", label: "In Progress", dot: "bg-accent", tint: "bg-accent/10" },
  { status: "done", label: "Claimed", dot: "bg-success", tint: "bg-success/10" },
] as const;

type Status = (typeof COLUMNS)[number]["status"];
const STATUSES = COLUMNS.map((c) => c.status) as Status[];

// Priority = quest "difficulty". Presentation only: none faint, low muted,
// medium warning, high error/red — the "the System" reads harder quests hotter.
const PRIORITY_ORDER = ["none", "low", "medium", "high"] as const;
const PRIORITY: Record<Task["priority"], { label: string; text: string; dot: string }> = {
  none: { label: "None", text: "text-faint", dot: "bg-faint" },
  low: { label: "Low", text: "text-muted", dot: "bg-muted" },
  medium: { label: "Medium", text: "text-warning", dot: "bg-warning" },
  high: { label: "High", text: "text-error", dot: "bg-error" },
};

// Fractional index between two neighbour positions, so a reorder only rewrites
// the moved card. Ends: just below the min / just above the max; empty column
// (both undefined) seeds a fresh position.
function between(prev?: number, next?: number): number {
  // Seconds, to match the DB's epoch-seconds positions (extract(epoch from now));
  // ms here would sort an empty-column drop ~1000x above freshly-created cards.
  if (prev === undefined && next === undefined) return Date.now() / 1000;
  if (prev === undefined) return next! - 1;
  if (next === undefined) return prev + 1;
  return (prev + next) / 2;
}
if (process.env.NODE_ENV !== "production") {
  console.assert(between(1, 3) === 2, "between(1,3)===2");
  console.assert(between(undefined, 3) < 3, "between(undefined,3)<3");
  console.assert(between(1, undefined) > 1, "between(1,undefined)>1");
}

// Today as "YYYY-MM-DD" in local time, for the past-due comparison. The API
// stores due_date as a plain date string, so compare strings, not Date objects.
function todayStr(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

// "Jul 20" style short label; the raw "YYYY-MM-DD" is kept as the title attr.
function dueLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m - 1];
  return `${mon} ${d}`;
}

export default function Tasks() {
  const { token, failed: onFail } = useAuthed();
  const qc = useQueryClient();
  const { data, error, isPending, refetch } = useQuery({
    queryKey: ["tasks", token],
    queryFn: () => getTasks(token),
    enabled: !!token,
  });

  // Local mirror of the fetched board so drag-reorder feels instant: the drag
  // handlers mutate this optimistically, then the drop's mutation invalidates
  // and the refetch re-syncs canonical order back into it. `null` until first
  // load, which the render below reads as the loading/error gate.
  const [tasks, setTasks] = useState<Task[] | null>(null);
  useEffect(() => {
    if (data) setTasks(data);
  }, [data]);

  const [activeId, setActiveId] = useState<string | null>(null); // dragged card

  // Surface a load failure to the shell — drives the single-flight token
  // refresh in page.tsx. A token change re-keys the query and refetches.
  useEffect(() => {
    if (error) onFail(error);
  }, [error, onFail]);

  // A click must not start a drag, or inline-edit and the delete button break.
  // 6px of travel is the Notion-ish threshold between "click" and "drag".
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // One mutation guarded by the row id; on success invalidate so the board
  // refetches canonical order. Per-row "busy" comes from the mutation vars.
  const mutation = useMutation({
    mutationFn: ({ fn }: { id: string; fn: () => Promise<unknown> }) => fn(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
    onError: onFail,
  });
  const busy = mutation.isPending ? mutation.variables?.id ?? null : null;
  const mutate = (id: string, fn: () => Promise<unknown>) => mutation.mutate({ id, fn });

  // Column contents, sorted by position ascending (equal positions keep their
  // fetch order via stable sort).
  const columnTasks = (status: Status): Task[] =>
    (tasks ?? []).filter((t) => t.status === status).sort((a, b) => a.position - b.position);

  // Which column an id belongs to: a column id is its own container; a card id
  // resolves to its task's status.
  const findContainer = (id: string): Status | undefined =>
    STATUSES.includes(id as Status) ? (id as Status) : tasks?.find((t) => t.id === id)?.status;

  // ◂ ▸ keyboard/click fallback: status-only column move (position carries over,
  // the refetch re-sorts). The guaranteed a11y path.
  const move = (task: Task, to: Status) => {
    if (task.status === to) return;
    setTasks((prev) =>
      prev ? prev.map((t) => (t.id === task.id ? { ...t, status: to } : t)) : prev,
    );
    void mutate(task.id, () => updateTask(token, task.id, { status: to }));
  };

  const setPriority = (task: Task, priority: Task["priority"]) => {
    if (task.priority === priority) return;
    setTasks((prev) =>
      prev ? prev.map((t) => (t.id === task.id ? { ...t, priority } : t)) : prev,
    );
    void mutate(task.id, () => updateTask(token, task.id, { priority }));
  };

  // ▴ ▾ tap fallback for within-column reorder. dnd-kit's PointerSensor loses to
  // the browser's scroll gesture on touch (we deliberately don't set
  // touch-action:none — that would kill scrolling), so reordering would
  // otherwise be desktop-only. Swap with the neighbour and persist one position.
  const bump = (task: Task, dir: -1 | 1) => {
    const list = columnTasks(task.status);
    const from = list.findIndex((t) => t.id === task.id);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= list.length) return;
    const ordered = arrayMove(list, from, to);
    const position = between(ordered[to - 1]?.position, ordered[to + 1]?.position);
    setTasks((prev) =>
      prev ? prev.map((t) => (t.id === task.id ? { ...t, position } : t)) : prev,
    );
    void mutate(task.id, () => updateTask(token, task.id, { position }));
  };

  function onDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }

  // Cross-column: pull the card into the column it's hovering so it renders
  // there mid-drag. Within a column the sortable strategy handles the visual
  // shift on its own — no state change needed until drop.
  function onDragOver(e: DragOverEvent) {
    const { active, over } = e;
    if (!over) return;
    const overContainer = findContainer(String(over.id));
    const activeContainer = findContainer(String(active.id));
    if (!overContainer || activeContainer === overContainer) return;
    setTasks((prev) =>
      prev ? prev.map((t) => (t.id === active.id ? { ...t, status: overContainer } : t)) : prev,
    );
  }

  function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;
    const overContainer = findContainer(String(over.id));
    const activeTask = tasks?.find((t) => t.id === active.id);
    if (!overContainer || !activeTask) return;

    // Ordered ids of the destination column, with the active card guaranteed
    // present (onDragOver may not have synced on a very fast drop).
    let ids = columnTasks(overContainer).map((t) => t.id);
    if (!ids.includes(activeTask.id)) ids = [...ids, activeTask.id];
    const from = ids.indexOf(activeTask.id);
    const overId = String(over.id);
    let to = overId === overContainer ? ids.length - 1 : ids.indexOf(overId);
    if (to < 0) to = ids.length - 1;

    // Same column, same slot, dropped on itself → nothing to persist.
    if (overContainer === activeTask.status && (from === to || overId === activeTask.id)) return;

    const ordered = arrayMove(ids, from, to);
    const idx = ordered.indexOf(activeTask.id);
    const byId = (id?: string) => (id ? tasks?.find((t) => t.id === id) : undefined);
    const position = between(byId(ordered[idx - 1])?.position, byId(ordered[idx + 1])?.position);

    setTasks((prev) =>
      prev
        ? prev.map((t) => (t.id === activeTask.id ? { ...t, status: overContainer, position } : t))
        : prev,
    );
    void mutate(activeTask.id, () =>
      updateTask(token, activeTask.id, { status: overContainer, position }),
    );
  }

  const today = todayStr();
  const total = tasks?.length ?? 0;
  const activeTask = tasks?.find((t) => t.id === activeId) ?? null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8">
      <div className="mx-auto flex min-h-0 max-w-6xl flex-col gap-6">
        <div>
          <h2 className="text-2xl font-semibold text-on-surface">Quest Log</h2>
          <p className="mt-2 text-sm text-muted">
            Drag a quest between columns or reorder within one, rename it in
            place, set its difficulty, or use the ◂ ▸ buttons. Clear a quest to
            claim its EXP.
          </p>
        </div>

        {tasks !== null && <SystemBar tasks={tasks} />}

        {isPending ? (
          <p className="text-sm text-faint">Loading…</p>
        ) : tasks === null ? (
          // Settled with no data → the load failed; offer a retry.
          <div className="flex flex-col items-start gap-2 rounded-xl border border-edge bg-panel px-4 py-3">
            <p className="text-sm text-error">Couldn’t load your quests.</p>
            <button
              type="button"
              onClick={() => void refetch()}
              className="min-h-11 rounded-md border border-edge bg-raised px-3 py-1 text-xs text-on-surface transition-colors hover:bg-panel md:min-h-0"
            >
              Retry
            </button>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDragEnd={onDragEnd}
            onDragCancel={() => setActiveId(null)}
          >
            {/* Columns scroll horizontally as a group so the page body never
                overflows. Below md each column is ~one screen wide and snaps,
                so a phone swipes between To Do / In Progress / Claimed. */}
            <div className="flex snap-x snap-mandatory gap-4 overflow-x-auto overscroll-x-contain pb-2 md:snap-none">
              {COLUMNS.map((col) => (
                <Column
                  key={col.status}
                  col={col}
                  tasks={columnTasks(col.status)}
                  today={today}
                  busy={busy}
                  onMove={move}
                  onBump={bump}
                  onPriority={setPriority}
                  onAdd={(title, due) =>
                    mutate("__add__", () =>
                      createTask(token, {
                        title,
                        due_date: due || undefined,
                      }).then((t) =>
                        // A brand-new task lands in To Do; nudge it to this
                        // column if the user added from elsewhere.
                        col.status === "open"
                          ? undefined
                          : updateTask(token, t.id, { status: col.status }),
                      ),
                    )
                  }
                  onRename={(t, title) =>
                    title.trim() && title !== t.title
                      ? mutate(t.id, () =>
                          updateTask(token, t.id, { title: title.trim() }),
                        )
                      : undefined
                  }
                  onDue={(t, due) =>
                    mutate(t.id, () =>
                      updateTask(token, t.id, { due_date: due || null }),
                    )
                  }
                  onDelete={(t) => mutate(t.id, () => deleteTask(token, t.id))}
                />
              ))}
            </div>

            {/* The floating card that follows the cursor — the Notion feel. */}
            <DragOverlay dropAnimation={null}>
              {activeTask ? (
                <div className="w-64 max-w-[80vw] rotate-2 rounded-lg border border-glow bg-raised p-2.5 shadow-2xl shadow-black/40 glow-violet">
                  <p className="break-words text-sm text-on-surface">
                    {activeTask.title}
                  </p>
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        )}

        {tasks !== null && total === 0 && (
          <p className="-mt-2 text-center text-sm text-faint">
            No quests yet — add one in a column above.
          </p>
        )}
      </div>
    </div>
  );
}

// The "System" status strip. XP is DERIVED client-side — sum of claimed quests'
// rewards — never fetched, never a stored counter.
function SystemBar({ tasks }: { tasks: Task[] }) {
  const xp = totalXp(tasks);
  const info = levelForXp(xp);
  const rank = rankForLevel(info.level);

  // Level-up moment: when a claimed quest crosses a boundary, flash the badge
  // once and show a "Level up!" tag for a beat. Client-side only, 0 tokens —
  // derived from the same math, no new write path. The tag still appears under
  // prefers-reduced-motion (the CSS flash is disabled there); it's the feedback.
  const prevLevel = useRef(info.level);
  const [leveledUp, setLeveledUp] = useState(false);
  useEffect(() => {
    if (info.level > prevLevel.current) {
      setLeveledUp(true);
      const t = setTimeout(() => setLeveledUp(false), 1400);
      prevLevel.current = info.level;
      return () => clearTimeout(t);
    }
    prevLevel.current = info.level;
  }, [info.level]);

  return (
    <div className="flex items-center gap-3 rounded-xl border border-edge bg-panel px-3 py-3 glow-violet md:px-4">
      <div
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-glow/40 bg-glow/10 text-sm font-semibold tabular-nums text-glow ${
          leveledUp ? "level-up" : ""
        }`}
        aria-hidden="true"
      >
        {info.level}
      </div>
      <div className="min-w-0 flex-1">
        {/* Wraps rather than overflowing once level + rank + EXP exceed 320px. */}
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium text-on-surface">Level {info.level}</span>
          <span className="text-xs text-glow">{rank.name}</span>
          {leveledUp && (
            <span
              role="status"
              className="rounded-full bg-glow/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-glow"
            >
              Level up!
            </span>
          )}
          <span className="ml-auto text-[11px] tabular-nums text-muted">{xp} EXP</span>
        </div>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-raised">
          <div
            className="h-full rounded-full bg-glow transition-[width] duration-500 motion-reduce:transition-none"
            style={{ width: `${Math.round(info.progress * 100)}%` }}
          />
        </div>
        <p className="mt-1 text-[11px] text-faint">{info.xpForNext} EXP to next level</p>
      </div>
    </div>
  );
}

function Column({
  col,
  tasks,
  today,
  busy,
  onMove,
  onBump,
  onPriority,
  onAdd,
  onRename,
  onDue,
  onDelete,
}: {
  col: (typeof COLUMNS)[number];
  tasks: Task[];
  today: string;
  busy: string | null;
  onMove: (task: Task, to: Status) => void;
  onBump: (task: Task, dir: -1 | 1) => void;
  onPriority: (task: Task, priority: Task["priority"]) => void;
  onAdd: (title: string, due: string) => void;
  onRename: (task: Task, title: string) => void;
  onDue: (task: Task, due: string) => void;
  onDelete: (task: Task) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: col.status });

  return (
    <section
      aria-label={`${col.label} column`}
      className="flex w-[85vw] max-w-xs shrink-0 snap-start flex-col rounded-xl border border-edge bg-panel md:w-72"
    >
      <header className="flex items-center gap-2 px-3 py-2.5">
        <span className={`h-2 w-2 rounded-full ${col.dot}`} aria-hidden="true" />
        <h3 className="text-sm font-medium text-on-surface">{col.label}</h3>
        <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] tabular-nums text-muted">
          {tasks.length}
        </span>
      </header>

      {/* The droppable body. min-height keeps an empty column a valid target. */}
      <div
        ref={setNodeRef}
        className={`flex min-h-[5rem] flex-1 flex-col gap-2 rounded-b-xl px-2 pb-2 transition-colors ${
          isOver ? col.tint : ""
        }`}
      >
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {tasks.length === 0 ? (
            <p className="px-1 py-5 text-center text-xs text-faint">Nothing here</p>
          ) : (
            tasks.map((t, i) => (
              <TaskCard
                key={t.id}
                task={t}
                today={today}
                busy={busy === t.id}
                first={i === 0}
                last={i === tasks.length - 1}
                onMove={onMove}
                onBump={(dir) => onBump(t, dir)}
                onPriority={(p) => onPriority(t, p)}
                onRename={(title) => onRename(t, title)}
                onDue={(due) => onDue(t, due)}
                onDelete={() => onDelete(t)}
              />
            ))
          )}
        </SortableContext>
        <AddCard onAdd={onAdd} />
      </div>
    </section>
  );
}

function TaskCard({
  task,
  today,
  busy,
  first,
  last,
  onMove,
  onBump,
  onPriority,
  onRename,
  onDue,
  onDelete,
}: {
  task: Task;
  today: string;
  busy: boolean;
  first: boolean;
  last: boolean;
  onMove: (task: Task, to: Status) => void;
  onBump: (dir: -1 | 1) => void;
  onPriority: (priority: Task["priority"]) => void;
  onRename: (title: string) => void;
  onDue: (due: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const [dueOpen, setDueOpen] = useState(false);

  // Dragging is disabled while editing so pointer events reach the input.
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({
    id: task.id,
    disabled: editing || busy,
  });
  // Reorder motion rides on the `transition-all` class (below) so that
  // `motion-reduce:transition-none` can disable it; an inline transition here
  // would override the class and ignore prefers-reduced-motion.
  const style = { transform: CSS.Translate.toString(transform) };

  const isDone = task.status === "done";
  const pastDue = !isDone && task.due_date !== null && task.due_date < today;

  const i = COLUMNS.findIndex((c) => c.status === task.status);
  const prev = COLUMNS[i - 1];
  const next = COLUMNS[i + 1];

  function commit() {
    setEditing(false);
    if (draft.trim() && draft.trim() !== task.title) onRename(draft.trim());
    else setDraft(task.title);
  }

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={`group rounded-lg border border-edge bg-raised p-2.5 transition-all motion-reduce:transition-none ${
        busy ? "opacity-40" : ""
      } ${isDragging ? "opacity-30" : ""} ${isDone ? "opacity-75" : ""}`}
    >
      <div className="flex items-start gap-2">
        {editing ? (
          <textarea
            autoFocus
            value={draft}
            rows={2}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                commit();
              }
              if (e.key === "Escape") {
                setDraft(task.title);
                setEditing(false);
              }
            }}
            className="min-w-0 flex-1 resize-none rounded border border-accent bg-panel px-1.5 py-1 text-base text-on-surface outline-none md:text-sm"
          />
        ) : (
          // The card body is the drag handle; a plain click (no travel) opens
          // the inline rename instead — the 6px sensor threshold separates them.
          <button
            type="button"
            {...listeners}
            {...attributes}
            onClick={() => setEditing(true)}
            className={`min-h-11 min-w-0 flex-1 cursor-grab break-words text-left text-sm active:cursor-grabbing md:min-h-0 ${
              isDone ? "text-muted line-through" : "text-on-surface"
            }`}
          >
            {task.title}
          </button>
        )}
        {/* Hover reveal is desktop-only; touch has no hover, so this stays
            visible (and 44px) below md. */}
        <button
          onClick={onDelete}
          disabled={busy}
          aria-label={`Delete task: ${task.title}`}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-panel hover:text-error focus:opacity-100 disabled:opacity-40 md:h-7 md:w-7 md:opacity-0 md:group-hover:opacity-100"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 md:h-3.5 md:w-3.5" aria-hidden="true">
            <path d="M3 6h18" />
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <path d="M6 6v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6" />
            <path d="M10 11v6M14 11v6" />
          </svg>
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1">
        <PriorityChip task={task} busy={busy} onPriority={onPriority} />

        {/* EXP reward — a claimed (done) quest reads as banked, greyed. */}
        <span
          title={isDone ? "EXP claimed" : "EXP reward on completion"}
          className={`rounded px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${
            isDone ? "bg-raised text-faint" : "bg-glow/10 text-glow"
          }`}
        >
          {isDone ? "✓ " : "+"}
          {questXp(task)} EXP
        </span>

        {/* Due date: a chip that opens a native date input; empty clears it. */}
        {dueOpen ? (
          <input
            type="date"
            autoFocus
            defaultValue={task.due_date ?? ""}
            onBlur={(e) => {
              setDueOpen(false);
              if ((e.target.value || "") !== (task.due_date ?? "")) onDue(e.target.value);
            }}
            aria-label="Due date"
            className="min-w-0 max-w-full rounded border border-accent bg-panel px-1 py-0.5 text-base text-on-surface outline-none [color-scheme:dark] md:text-xs"
          />
        ) : task.due_date ? (
          <button
            onClick={() => setDueOpen(true)}
            title={task.due_date}
            className={`min-h-11 rounded px-2 py-0.5 text-xs transition-colors hover:bg-panel md:min-h-0 md:px-1 ${
              pastDue ? "text-warning" : "text-muted"
            }`}
          >
            {dueLabel(task.due_date)}
          </button>
        ) : (
          <button
            onClick={() => setDueOpen(true)}
            className="min-h-11 rounded px-2 py-0.5 text-xs text-faint transition-colors hover:bg-panel hover:text-muted focus:opacity-100 md:min-h-0 md:px-1 md:opacity-0 md:group-hover:opacity-100"
          >
            ＋ due
          </button>
        )}

        {/* Keyboard/click move fallback — the guaranteed a11y path, and the only
            way to move a card on touch (see `bump` for the reorder equivalent).
            Grouped so the four controls wrap as one block on a narrow card. */}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => prev && onMove(task, prev.status)}
            disabled={busy || !prev}
            aria-label={prev ? `Move "${task.title}" to ${prev.label}` : "No column to the left"}
            className="flex h-11 w-11 items-center justify-center rounded text-muted transition-colors enabled:hover:bg-panel enabled:hover:text-on-surface disabled:opacity-30 md:h-6 md:w-6"
          >
            <Chevron dir="left" />
          </button>
          <button
            onClick={() => next && onMove(task, next.status)}
            disabled={busy || !next}
            aria-label={next ? `Move "${task.title}" to ${next.label}` : "No column to the right"}
            className="flex h-11 w-11 items-center justify-center rounded text-muted transition-colors enabled:hover:bg-panel enabled:hover:text-on-surface disabled:opacity-30 md:h-6 md:w-6"
          >
            <Chevron dir="right" />
          </button>
          {/* Touch reorder: drag can't run on touch, so expose it as taps wherever
              the primary pointer is coarse (phones AND touch tablets). */}
          <button
            onClick={() => onBump(-1)}
            disabled={busy || first}
            aria-label={`Move "${task.title}" up`}
            className="flex h-11 w-11 items-center justify-center rounded text-muted transition-colors enabled:hover:bg-panel enabled:hover:text-on-surface disabled:opacity-30 pointer-fine:hidden"
          >
            <Chevron dir="up" />
          </button>
          <button
            onClick={() => onBump(1)}
            disabled={busy || last}
            aria-label={`Move "${task.title}" down`}
            className="flex h-11 w-11 items-center justify-center rounded text-muted transition-colors enabled:hover:bg-panel enabled:hover:text-on-surface disabled:opacity-30 pointer-fine:hidden"
          >
            <Chevron dir="down" />
          </button>
        </div>
      </div>
    </article>
  );
}

// Difficulty chip → 4-option picker. PATCHes priority directly (0 tokens). The
// backdrop button closes the menu on any outside click.
function PriorityChip({
  task,
  busy,
  onPriority,
}: {
  task: Task;
  busy: boolean;
  onPriority: (priority: Task["priority"]) => void;
}) {
  const [open, setOpen] = useState(false);
  const p = PRIORITY[task.priority];
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Difficulty: ${p.label}. Change.`}
        className={`flex min-h-11 items-center gap-1 rounded px-2 py-0.5 text-xs transition-colors hover:bg-panel disabled:opacity-40 md:min-h-0 md:px-1 ${p.text}`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${p.dot}`} aria-hidden="true" />
        {p.label}
      </button>
      {open && (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div
            role="menu"
            className="absolute left-0 top-full z-20 mt-1 w-32 rounded-lg border border-edge bg-panel p-1 shadow-xl shadow-black/40"
          >
            {PRIORITY_ORDER.map((k) => (
              <button
                key={k}
                role="menuitemradio"
                aria-checked={k === task.priority}
                onClick={() => {
                  setOpen(false);
                  if (k !== task.priority) onPriority(k);
                }}
                className={`flex min-h-11 w-full items-center gap-2 rounded px-2 py-1 text-left text-xs transition-colors hover:bg-raised md:min-h-0 ${
                  PRIORITY[k].text
                } ${k === task.priority ? "bg-raised" : ""}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${PRIORITY[k].dot}`} aria-hidden="true" />
                {PRIORITY[k].label}
                <span className="ml-auto text-[10px] tabular-nums text-faint">
                  +{XP_BY_PRIORITY[k]}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Inline add at the bottom of a column — collapses to a "+ Add" affordance
// until clicked, so the column stays quiet. Creates directly in this column.
function AddCard({ onAdd }: { onAdd: (title: string, due: string) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  function commit() {
    const t = title.trim();
    if (t) onAdd(t, "");
    setTitle("");
    setOpen(false);
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="min-h-11 rounded-lg px-2 py-1.5 text-left text-xs text-faint transition-colors hover:bg-raised hover:text-muted md:min-h-0"
      >
        ＋ Add a quest
      </button>
    );
  }
  return (
    <div className="rounded-lg border border-accent bg-raised p-2">
      <textarea
        ref={ref}
        autoFocus
        rows={2}
        value={title}
        placeholder="What needs doing?"
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => (title.trim() ? commit() : setOpen(false))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            commit();
          }
          if (e.key === "Escape") {
            setTitle("");
            setOpen(false);
          }
        }}
        className="w-full resize-none bg-transparent text-base text-on-surface placeholder:text-faint outline-none md:text-sm"
      />
    </div>
  );
}

const CHEVRON_PATH = {
  left: "M15 18l-6-6 6-6",
  right: "M9 18l6-6-6-6",
  up: "M18 15l-6-6-6 6",
  down: "M6 9l6 6 6-6",
} as const;

function Chevron({ dir }: { dir: keyof typeof CHEVRON_PATH }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
      <path d={CHEVRON_PATH[dir]} />
    </svg>
  );
}
