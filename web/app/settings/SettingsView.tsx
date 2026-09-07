"use client";

import { useCallback, useEffect, useState } from "react";
import {
  activateProvider,
  addProvider,
  clearLifeboat,
  listProviders,
  setLifeboat,
  type Credential,
} from "@/lib/gateway";
import { useAuthed } from "../auth/AuthProvider";
import AddProviderForm from "./AddProviderForm";
import AssistantNameForm from "./AssistantNameForm";
import GoogleSection from "./GoogleSection";
import MailSection from "./MailSection";
import TimezoneForm from "./TimezoneForm";

// --- settings: model providers + lifeboat designation ----------------------

const PROVIDER_LABEL: Record<Credential["provider"], string> = {
  anthropic: "Claude (Anthropic)",
  openai_compat: "OpenRouter",
  local: "Local (Ollama)",
};

export default function SettingsView({
  assistantName,
  onSaved,
  googleReload,
  googleNotice,
}: {
  assistantName: string;
  onSaved: (name: string) => void;
  googleReload: number;
  googleNotice: { ok: boolean; msg: string } | null;
}) {
  const { token } = useAuthed();
  const [creds, setCreds] = useState<Credential[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // id currently mutating

  const load = useCallback(async () => {
    try {
      setCreds(await listProviders(token));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(id: string, fn: () => Promise<unknown>) {
    setBusy(id);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const lifeboat = creds?.find((c) => c.is_lifeboat);

  return (
    <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-6 md:py-8">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <AssistantNameForm assistantName={assistantName} onSaved={onSaved} />

        <TimezoneForm />

        <div>
          <h2 className="text-xl font-semibold text-on-surface sm:text-2xl">
            Model providers
          </h2>
          <p className="mt-2 text-sm text-muted">
            The <span className="font-medium text-on-surface">active</span> provider answers your messages. The{" "}
            <span className="font-medium text-on-surface">fallback</span> takes over only if the active provider&apos;s
            credential is rejected — an expired key or an unpaid bill — and the reply is marked as
            degraded. Rate limits and outages are not a fallback; they surface as an error.
          </p>
        </div>

        {error && (
          <div
            role="alert"
            className="border-l-2 border-error bg-error/10 px-3 py-2 text-sm text-error"
          >
            {error}
          </div>
        )}

        {!lifeboat && creds && creds.length > 0 && (
          <div
            role="status"
            className="border-l-2 border-warning bg-warning/10 px-3 py-2 text-sm text-warning"
          >
            No fallback set. If your active credential is rejected, the assistant will stop instead of
            degrading. Designate a fallback below — a local or OpenRouter provider.
          </div>
        )}

        <div className="flex flex-col gap-2">
          {creds === null && <p className="text-sm text-faint">Loading…</p>}
          {creds?.length === 0 && (
            <p className="text-sm text-faint">No providers yet. Add one below.</p>
          )}
          {creds?.map((c) => (
            <div
              key={c.id}
              className="flex flex-col gap-3 rounded-xl border border-edge bg-panel px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-on-surface">{PROVIDER_LABEL[c.provider]}</span>
                  {c.is_active && (
                    <span className="rounded-md bg-accent/15 px-2 py-0.5 text-[11px] font-medium uppercase tracking-widest text-accent">
                      Active
                    </span>
                  )}
                  {c.is_lifeboat && (
                    <span className="rounded-md bg-raised px-2 py-0.5 text-[11px] font-medium uppercase tracking-widest text-muted">
                      Fallback
                    </span>
                  )}
                </div>
                <div className="truncate text-xs text-muted">
                  {c.model_id} · {c.auth_type}
                  {c.base_url ? ` · ${c.base_url}` : ""}
                </div>
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {!c.is_active && (
                  <button
                    disabled={busy === c.id}
                    onClick={() => void run(c.id, () => activateProvider(token, c.id))}
                    className="min-h-11 rounded-md border border-edge px-3 py-2 text-xs text-muted transition-colors hover:bg-raised hover:text-on-surface disabled:opacity-40"
                  >
                    Use this
                  </button>
                )}
                {c.is_lifeboat ? (
                  <button
                    disabled={busy === c.id}
                    onClick={() => void run(c.id, () => clearLifeboat(token, c.id))}
                    className="min-h-11 rounded-md border border-edge px-3 py-2 text-xs text-muted transition-colors hover:bg-raised hover:text-on-surface disabled:opacity-40"
                  >
                    Clear fallback
                  </button>
                ) : (
                  // The active credential can't also be the fallback.
                  !c.is_active && (
                    <button
                      disabled={busy === c.id}
                      onClick={() => void run(c.id, () => setLifeboat(token, c.id))}
                      className="min-h-11 rounded-md bg-accent/15 px-3 py-2 text-xs text-accent transition-colors hover:bg-accent/25 disabled:opacity-40"
                    >
                      Set as fallback
                    </button>
                  )
                )}
              </div>
            </div>
          ))}
        </div>

        <AddProviderForm
          onAdd={async (cred) => {
            setError(null);
            try {
              await addProvider(token, cred);
              await load();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
              throw e;
            }
          }}
        />

        <GoogleSection reload={googleReload} notice={googleNotice} />

        <MailSection />
      </div>
    </div>
  );
}
