"use client";

import { useCallback, useEffect, useState } from "react";
import {
  createTask,
  deleteTask,
  getTasks,
  updateTask,
  type Task,
} from "@/lib/gateway";

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

  const open = tasks?.filter((t) => t.status === "open") ?? [];
  const done = tasks?.filter((t) => t.status === "done") ?? [];
  const today = todayStr();

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <div>
          <h2 className="text-2xl font-semibold text-on-surface">Tasks</h2>
          <p className="mt-2 text-sm text-muted">
            A simple to-do list. Open tasks first, done ones below.
          </p>
        </div>

        {/* Quick-add */}
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

        {/* List */}
        {tasks === null ? (
          <p className="text-sm text-faint">Loading…</p>
        ) : tasks.length === 0 ? (
          <p className="py-8 text-center text-sm text-faint">
            No tasks yet — add one above.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {open.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                today={today}
                busy={busy === t.id}
                onToggle={() =>
                  void mutate(t.id, () =>
                    updateTask(token, t.id, { status: "done" }),
                  )
                }
                onDelete={() =>
                  void mutate(t.id, () => deleteTask(token, t.id))
                }
              />
            ))}

            {done.length > 0 && (
              <>
                <div className="mt-2 flex items-center gap-2 px-1 text-[11px] uppercase tracking-widest text-faint">
                  Done
                  <span className="h-px flex-1 bg-edge" />
                </div>
                {done.map((t) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    today={today}
                    busy={busy === t.id}
                    onToggle={() =>
                      void mutate(t.id, () =>
                        updateTask(token, t.id, { status: "open" }),
                      )
                    }
                    onDelete={() =>
                      void mutate(t.id, () => deleteTask(token, t.id))
                    }
                  />
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TaskRow({
  task,
  today,
  busy,
  onToggle,
  onDelete,
}: {
  task: Task;
  today: string;
  busy: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const isDone = task.status === "done";
  const pastDue = !isDone && task.due_date !== null && task.due_date < today;

  return (
    <div className="flex items-center gap-3 rounded-xl border border-edge bg-panel px-3 py-2.5">
      <input
        type="checkbox"
        checked={isDone}
        disabled={busy}
        onChange={onToggle}
        aria-label={task.title}
        className="h-4 w-4 shrink-0 accent-accent disabled:opacity-40"
      />
      <span
        className={`min-w-0 flex-1 truncate text-sm ${
          isDone ? "text-muted line-through" : "text-on-surface"
        }`}
        title={task.title}
      >
        {task.title}
      </span>
      {task.due_date && (
        <span
          className={`shrink-0 text-xs ${pastDue ? "text-warning" : "text-muted"}`}
        >
          {task.due_date}
        </span>
      )}
      <button
        onClick={onDelete}
        disabled={busy}
        aria-label={`Delete task: ${task.title}`}
        className="shrink-0 rounded-md p-1 text-muted transition-colors hover:bg-raised hover:text-error disabled:opacity-40"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4"
          aria-hidden="true"
        >
          <path d="M3 6h18" />
          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <path d="M6 6v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6" />
          <path d="M10 11v6M14 11v6" />
        </svg>
      </button>
    </div>
  );
}
