"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getMailConfig,
  getMailStats,
  googleStatus,
  saveMailConfig,
  type MailConfig,
  type MailStats,
} from "@/lib/gateway";
import { useAuthed } from "../auth/AuthProvider";

// Mail sorting settings.
//
// Two things this screen exists to make honest:
//
//  1. A user who connected Google BEFORE mail existed holds a Calendar-only
//     grant. Mail cannot work for them and no amount of retrying will fix it,
//     so the switch is disabled and says why, rather than silently doing nothing.
//
//  2. When nothing is happening, it says what. last_error, backfill progress and
//     last_synced_at are all surfaced — a background worker that has quietly
//     stopped is indistinguishable from a quiet inbox otherwise.

export default function MailSection() {
  const { token, failed: onFail } = useAuthed();
  const [cfg, setCfg] = useState<MailConfig | null>(null);
  const [stats, setStats] = useState<MailStats | null>(null);
  const [mailScope, setMailScope] = useState<boolean | null>(null);
  const [chatId, setChatId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [c, s, g] = await Promise.all([
        getMailConfig(token),
        getMailStats(token),
        googleStatus(token),
      ]);
      setCfg(c);
      setStats(s);
      setMailScope(g.connected ? g.mail_scope_granted : null);
      setChatId(c.telegram_chat_id ?? "");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      onFail(e);
    }
  }, [token, onFail]);

  useEffect(() => {
    void load();
  }, [load]);

  async function patch(p: Parameters<typeof saveMailConfig>[1]) {
    setBusy(true);
    setErr(null);
    try {
      setCfg(await saveMailConfig(token, p));
      setStats(await getMailStats(token));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      onFail(e);
    } finally {
      setBusy(false);
    }
  }

  const canEnable = mailScope === true;
  const tiers = stats?.tiers ?? {};
  const states = stats?.states ?? {};
  const backfilling = !!cfg?.backfill_cursor;

  return (
    <div className="rounded-xl border border-edge bg-panel p-4">
      <h3 className="mb-1 text-base font-semibold text-on-surface">Mail sorting</h3>
      <p className="mb-4 text-sm text-muted">
        Reads your Gmail, sorts it with a model running on this machine, and
        labels it. Nothing is ever deleted, replied to, or sent. You are only
        notified about mail that needs you.
      </p>

      {err && (
        <div role="alert" className="mb-3 border-l-2 border-error bg-error/10 px-3 py-2 text-sm text-error">
          {err}
        </div>
      )}

      {mailScope === null && (
        <p className="mb-3 text-sm text-faint">
          Connect your Google account above to use mail sorting.
        </p>
      )}

      {mailScope === false && (
        <div role="status" className="mb-3 border-l-2 border-warning bg-warning/10 px-3 py-2 text-sm text-warning">
          Your Google account was connected before mail sorting existed, so it
          only has calendar access. Disconnect and reconnect Google above to
          grant mail access.
        </div>
      )}

      <label className="flex items-center gap-3 py-2">
        <input
          type="checkbox"
          checked={!!cfg?.enabled}
          disabled={busy || !canEnable}
          onChange={(e) => void patch({ enabled: e.target.checked })}
          className="size-4 accent-accent disabled:opacity-40"
        />
        <span className="text-sm text-on-surface">
          Sort my mail
          {!canEnable && <span className="ml-2 text-xs text-faint">(needs mail access)</span>}
        </span>
      </label>

      <label className="flex items-center gap-3 py-2">
        <input
          type="checkbox"
          checked={!!cfg?.alerts_enabled}
          disabled={busy || !cfg?.enabled}
          onChange={(e) => void patch({ alerts_enabled: e.target.checked })}
          className="size-4 accent-accent disabled:opacity-40"
        />
        <span className="text-sm text-on-surface">
          Notify me about mail that needs action
        </span>
      </label>

      <div className="mt-4">
        <label htmlFor="tg-chat" className="mb-1 block text-sm text-on-surface">
          Telegram chat ID
        </label>
        <p className="mb-2 text-xs text-muted">
          Message your bot once, then open{" "}
          <span className="font-mono">api.telegram.org/bot&lt;token&gt;/getUpdates</span> and
          copy the chat id. Leave empty to keep notifications in the app only.
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            id="tg-chat"
            value={chatId}
            inputMode="numeric"
            placeholder="123456789"
            onChange={(e) => setChatId(e.target.value)}
            className="min-h-11 flex-1 rounded-md border border-edge bg-surface px-3 py-2 text-sm text-on-surface"
          />
          <button
            disabled={busy || chatId === (cfg?.telegram_chat_id ?? "")}
            onClick={() => void patch({ telegram_chat_id: chatId })}
            className="min-h-11 rounded-md bg-accent/15 px-3 py-2 text-xs text-accent transition-colors hover:bg-accent/25 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ["Needs you now", tiers.act_now ?? 0],
          ["Soon", tiers.act_soon ?? 0],
          ["For information", tiers.fyi ?? 0],
          ["Noise", tiers.noise ?? 0],
        ].map(([label, n]) => (
          <div key={String(label)} className="rounded-md border border-edge px-3 py-2">
            <div className="text-lg font-semibold text-on-surface">{n}</div>
            <div className="text-xs text-muted">{label}</div>
          </div>
        ))}
      </div>

      {/* Status, so "nothing happened" always has a stated reason. */}
      <div className="mt-3 space-y-1 text-xs text-muted">
        {backfilling && (
          <p>
            Importing your last {cfg?.backfill_days} days of mail. This runs in the
            background and can take a few hours — no notifications are sent for it.
          </p>
        )}
        {!backfilling && cfg?.backfill_done_at && (
          <p>Import finished. Checking for new mail every few minutes.</p>
        )}
        {typeof states.failed === "number" && states.failed > 0 && (
          <p className="text-warning">{states.failed} messages could not be read. They will be retried.</p>
        )}
        {cfg?.last_synced_at && <p>Last checked {new Date(cfg.last_synced_at).toLocaleString()}.</p>}
        {cfg?.last_error && <p className="text-error">Last error: {cfg.last_error}</p>}
      </div>
    </div>
  );
}
