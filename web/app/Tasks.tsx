"use client";

import { useCallback, useEffect, useState } from "react";
import {
  createTask,
  deleteTask,
  getTasks,
  updateTask,
  type Task,
} from "@/lib/gateway";

// The board's three columns, left to right. `status` is the frozen contract
// value the API stores; `label` is the human column heading.
const COLUMNS = [
  { status: "open", label: "To Do" },
  { status: "in_progress", label: "In Progress" },
  { status: "done", label: "Done" },
] as const;

type Status = (typeof COLUMNS)[number]["status"];

// Today as "YYYY-MM-DD" in local time, for the past-due comparison. The API
// stores due_date as a plain date string, so compare strings, not Date objects.
function todayStr(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export default function Tasks({
  token,
  onFail,
}: {
  token: string;
  onFail: (e: unknown) => void;
}) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // id currently mutating
  const [dragOver, setDragOver] = useState<Status | null>(null); // hovered column

  const load = useCallback(async () => {
    try {
      setTasks(await getTasks(token));
    } catch (e) {
      onFail(e);
    }
  }, [token, onFail]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    const t = title.trim();
    if (!t || adding) return;
    setAdding(true);
    try {
      await createTask(token, { title: t, due_date: due || undefined });
      setTitle("");
      setDue("");
      await load();
    } catch (e) {
      onFail(e);
    } finally {
      setAdding(false);
    }
  }

  // A single mutation guarded by the row id, then a reload for canonical order.
  async function mutate(id: string, fn: () => Promise<unknown>) {
    setBusy(id);
    try {
      await fn();
      await load();
    } catch (e) {
      onFail(e);
    } finally {
      setBusy(null);
    }
  }

  function move(task: Task, to: Status) {
    if (task.status === to) return;
    void mutate(task.id, () => updateTask(token, task.id, { status: to }));
  }

  const today = todayStr();
  const total = tasks?.length ?? 0;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8">
      <div className="mx-auto flex min-h-0 max-w-5xl flex-col gap-6">
        <div>
          <h2 className="text-2xl font-semibold text-on-surface">Tasks</h2>
          <p className="mt-2 text-sm text-muted">
            A kanban board. Drag a card between columns, or use the move
            buttons.
          </p>
        </div>

        {/* Quick-add — always creates a To Do task */}
        <div className="flex flex-wrap items-end gap-2 rounded-xl border border-edge bg-panel p-3">
          <label className="flex min-w-[12rem] flex-1 flex-col gap-1.5 text-sm">
            <span className="text-[11px] uppercase tracking-widest text-faint">
              New task
            </span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void add();
                }
              }}
              placeholder="What needs doing?"
              className="rounded-md border border-edge bg-raised px-2 py-1.5 text-on-surface placeholder:text-faint outline-none transition-colors focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-[11px] uppercase tracking-widest text-faint">
              Due date
            </span>
            <input
              type="date"
              value={due}
              onChange={(e) => setDue(e.target.value)}
              aria-label="Due date"
              className="rounded-md border border-edge bg-raised px-2 py-1.5 text-on-surface outline-none transition-colors focus:border-accent [color-scheme:dark]"
            />
          </label>
          <button
            onClick={() => void add()}
            disabled={adding || !title.trim()}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong disabled:opacity-40"
          >
            {adding ? "Adding…" : "Add"}
          </button>
        </div>

        {/* Board */}
        {tasks === null ? (
          <p className="text-sm text-faint">Loading…</p>
        ) : total === 0 ? (
          <p className="py-8 text-center text-sm text-faint">
            No tasks yet — add one above.
          </p>
        ) : (
          // Columns scroll horizontally as a group on a narrow window so the
          // page body never overflows.
          <div className="flex gap-4 overflow-x-auto pb-2">
            {COLUMNS.map((col) => (
              <Column
                key={col.status}
                status={col.status}
                label={col.label}
                tasks={tasks.filter((t) => t.status === col.status)}
                today={today}
                busy={busy}
                dragOver={dragOver === col.status}
                onDragEnterCol={() => setDragOver(col.status)}
                onDragLeaveCol={() => setDragOver((s) => (s === col.status ? null : s))}
                onDropTask={(id) => {
                  setDragOver(null);
                  const task = tasks.find((t) => t.id === id);
                  if (task) move(task, col.status);
                }}
                onMove={move}
                onDelete={(t) =>
                  void mutate(t.id, () => deleteTask(token, t.id))
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Column({
  status,
  label,
  tasks,
  today,
  busy,
  dragOver,
  onDragEnterCol,
  onDragLeaveCol,
  onDropTask,
  onMove,
  onDelete,
}: {
  status: Status;
  label: string;
  tasks: Task[];
  today: string;
  busy: string | null;
  dragOver: boolean;
  onDragEnterCol: () => void;
  onDragLeaveCol: () => void;
  onDropTask: (id: string) => void;
  onMove: (task: Task, to: Status) => void;
  onDelete: (task: Task) => void;
}) {
  return (
    <section
      aria-label={`${label} column`}
      onDragOver={(e) => {
        e.preventDefault(); // allow drop
        onDragEnterCol();
      }}
      onDragLeave={(e) => {
        // Ignore moves between the column's own children.
        if (!e.currentTarget.contains(e.relatedTarget as Node)) onDragLeaveCol();
      }}
      onDrop={(e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData("text/plain");
        if (id) onDropTask(id);
      }}
      className={`flex w-72 shrink-0 flex-col rounded-xl border bg-panel transition-colors ${
        dragOver ? "border-accent bg-accent/10" : "border-edge"
      }`}
    >
      <header className="flex items-center gap-2 px-3 py-2.5">
        <h3 className="text-sm font-medium text-on-surface">{label}</h3>
        <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] tabular-nums text-muted">
          {tasks.length}
        </span>
      </header>
      <div className="flex min-h-[6rem] flex-col gap-2 overflow-y-auto px-2 pb-2">
        {tasks.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-faint">
            Nothing here
          </p>
        ) : (
          tasks.map((t) => (
            <TaskCard
              key={t.id}
              task={t}
              today={today}
              busy={busy === t.id}
              onMove={onMove}
              onDelete={() => onDelete(t)}
            />
          ))
        )}
      </div>
    </section>
  );
}

function TaskCard({
  task,
  today,
  busy,
  onMove,
  onDelete,
}: {
  task: Task;
  today: string;
  busy: boolean;
  onMove: (task: Task, to: Status) => void;
  onDelete: () => void;
}) {
  const isDone = task.status === "done";
  const pastDue = !isDone && task.due_date !== null && task.due_date < today;

  const i = COLUMNS.findIndex((c) => c.status === task.status);
  const prev = COLUMNS[i - 1];
  const next = COLUMNS[i + 1];

  return (
    <article
      draggable={!busy}
      onDragStart={(e) => e.dataTransfer.setData("text/plain", task.id)}
      className={`group rounded-lg border border-edge bg-raised p-2.5 transition-opacity ${
        busy ? "opacity-40" : "cursor-grab active:cursor-grabbing"
      }`}
    >
      <div className="flex items-start gap-2">
        <p
          className={`min-w-0 flex-1 break-words text-sm ${
            isDone ? "text-muted line-through" : "text-on-surface"
          }`}
        >
          {task.title}
        </p>
        <button
          onClick={onDelete}
          disabled={busy}
          aria-label={`Delete task: ${task.title}`}
          className="shrink-0 rounded-md p-1 text-faint opacity-0 transition-colors hover:bg-panel hover:text-error focus:opacity-100 group-hover:opacity-100 disabled:opacity-40"
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
      </div>

      <div className="mt-2 flex items-center gap-1">
        {task.due_date && (
          <span
            className={`mr-auto text-xs ${pastDue ? "text-warning" : "text-muted"}`}
          >
            {task.due_date}
          </span>
        )}
        {/* Keyboard/click move fallback — native drag-drop is mouse-only. */}
        <button
          onClick={() => prev && onMove(task, prev.status)}
          disabled={busy || !prev}
          aria-label={
            prev ? `Move task "${task.title}" to ${prev.label}` : "No column to the left"
          }
          className="ml-auto rounded p-0.5 text-muted transition-colors enabled:hover:bg-panel enabled:hover:text-on-surface disabled:opacity-30"
        >
          <Chevron dir="left" />
        </button>
        <button
          onClick={() => next && onMove(task, next.status)}
          disabled={busy || !next}
          aria-label={
            next ? `Move task "${task.title}" to ${next.label}` : "No column to the right"
          }
          className="rounded p-0.5 text-muted transition-colors enabled:hover:bg-panel enabled:hover:text-on-surface disabled:opacity-30"
        >
          <Chevron dir="right" />
        </button>
      </div>
    </article>
  );
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path d={dir === "left" ? "M15 18l-6-6 6-6" : "M9 18l6-6-6-6"} />
    </svg>
  );
}
