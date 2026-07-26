"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getNotifications,
  markNotificationRead,
  type Notification,
} from "@/lib/gateway";
import { useAuthed } from "./auth/AuthProvider";

// The notifications bell: polls the unread feed for a badge, and on open marks
// that batch read (one PATCH per id) and shows it. Poll-based delivery, reusing
// the REST proxy — no SSE, no tokens. Firing writes the notification row (the sink).
export default function NotificationsBell() {
  const { token, failed: onFail } = useAuthed();
  const qc = useQueryClient();
  const [viewing, setViewing] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);

  // Poll unread every 45s via TanStack's refetchInterval (replaces a manual
  // setInterval). enabled on token; the query re-keys on token change.
  const { data: unread = [], error } = useQuery({
    queryKey: ["notifications", token],
    queryFn: () => getNotifications(token, { unread: true }),
    enabled: !!token,
    refetchInterval: 45000,
  });
  useEffect(() => {
    if (error) onFail(error);
  }, [error, onFail]);

  // Opening snapshots the current unread batch, clears the badge optimistically
  // (setQueryData), and marks each read server-side; the next poll confirms.
  function toggle() {
    if (!open) {
      setViewing(unread);
      if (unread.length > 0) {
        const ids = unread.map((n) => n.id);
        qc.setQueryData<Notification[]>(["notifications", token], []);
        ids.forEach((id) => void markNotificationRead(token, id).catch(onFail));
      }
    }
    setOpen((o) => !o);
  }

  return (
    <div className="absolute right-4 top-3 z-20">
      <button
        onClick={toggle}
        aria-label={`Notifications${unread.length ? ` (${unread.length} unread)` : ""}`}
        className="relative flex h-9 w-9 items-center justify-center rounded-full border border-edge bg-panel text-muted shadow-sm transition-colors hover:text-on-surface"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread.length > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-on-accent">
            {unread.length > 9 ? "9+" : unread.length}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* Click-away backdrop — closes the panel without a modal library. */}
          <button
            aria-label="Close notifications"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-0 cursor-default"
          />
          <div className="absolute right-0 z-10 mt-2 w-80 overflow-hidden rounded-xl border border-edge bg-panel shadow-lg">
            <div className="border-b border-edge px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-faint">
              Notifications
            </div>
            <div className="max-h-80 overflow-y-auto">
              {viewing.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-faint">
                  No new notifications.
                </p>
              ) : (
                viewing.map((n) => (
                  <div
                    key={n.id}
                    className="border-b border-edge/60 px-3 py-2 last:border-0"
                  >
                    <p className="whitespace-pre-wrap text-sm text-on-surface">
                      {n.content}
                    </p>
                    {n.created_at && (
                      <p className="mt-0.5 text-xs text-muted">
                        {new Date(n.created_at).toLocaleString([], {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </p>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
