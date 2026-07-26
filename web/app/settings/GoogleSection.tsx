"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  connectGoogle,
  disconnectGoogle,
  googleStatus,
  type GoogleStatus,
} from "@/lib/gateway";
import { useAuthed } from "../auth/AuthProvider";

// Read-only Google connector: link/unlink the user's Calendar + profile. The
// gateway owns the OAuth dance; this only kicks it off and reflects status.
export default function GoogleSection({
  reload,
  notice,
}: {
  reload: number;
  notice: { ok: boolean; msg: string } | null;
}) {
  const { token, failed: onFail } = useAuthed();
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Set only when /connect answers 503 — this deployment has no Google
  // credentials, so the connector is inert by design (like web search with no key).
  const [notConfigured, setNotConfigured] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await googleStatus(token));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      onFail(e); // funnel 401s to a logout; never a silent console.error
    }
  }, [token, onFail]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus, reload]);

  async function connect() {
    setBusy(true);
    setErr(null);
    try {
      const { auth_url } = await connectGoogle(token);
      window.location.href = auth_url; // -> Google's consent screen
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) {
        setNotConfigured(true);
      } else {
        setErr(e instanceof Error ? e.message : String(e));
        onFail(e);
      }
      setBusy(false); // on success we're navigating away, so don't unset then
    }
  }

  async function disconnect() {
    setBusy(true);
    setErr(null);
    try {
      await disconnectGoogle(token);
      await loadStatus();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      onFail(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-edge bg-panel p-4">
      <h3 className="mb-1 text-base font-semibold text-on-surface">Google</h3>
      <p className="mb-4 text-sm text-muted">
        Connect your Google account so the assistant can look at your calendar
        when a message needs it.
      </p>

      {notice && (
        <div
          role={notice.ok ? "status" : "alert"}
          className={`mb-3 border-l-2 px-3 py-2 text-sm ${
            notice.ok
              ? "border-accent bg-accent/10 text-accent"
              : "border-error bg-error/10 text-error"
          }`}
        >
          {notice.msg}
        </div>
      )}

      {err && (
        <div
          role="alert"
          className="mb-3 border-l-2 border-error bg-error/10 px-3 py-2 text-sm text-error"
        >
          {err}
        </div>
      )}

      {status?.connected ? (
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 text-sm text-on-surface">
            Connected as{" "}
            <span className="font-medium">{status.email ?? "your Google account"}</span>
          </p>
          <button
            onClick={() => void disconnect()}
            disabled={busy}
            className="shrink-0 rounded-md border border-edge px-2.5 py-1 text-xs text-muted transition-colors hover:bg-raised hover:text-on-surface disabled:opacity-40"
          >
            {busy ? "Working…" : "Disconnect"}
          </button>
        </div>
      ) : notConfigured ? (
        <p className="text-sm text-faint">
          Google connector isn&apos;t configured on this deployment.
        </p>
      ) : (
        <>
          <button
            onClick={() => void connect()}
            disabled={busy || status === null}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong disabled:opacity-40"
          >
            {busy ? "Connecting…" : "Connect Google"}
          </button>
          {/* PRIVACY DISCLOSURE — required, visible text (not a tooltip). */}
          <p className="mt-3 text-sm text-muted">
            Connecting lets Raphael read your Google Calendar, and only when a
            message actually needs it. The calendar text it reads for that turn
            is sent to your active model provider to answer — if your active
            provider is Claude or OpenRouter, that data goes to them; if it&apos;s
            your local model, it stays on this machine. Access is read-only:
            Raphael cannot create, change, or delete anything in your calendar.
            You can disconnect at any time.
          </p>
        </>
      )}
    </div>
  );
}
