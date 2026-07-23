"use client";

// Admin-only console: User Management (allowlist + users) and System Settings
// (the system-wide provider/model config). Rendered only when role === "admin"
// (Sidebar hides the nav; page.tsx guards the view). The server still enforces
// via requireAdmin on every mutation — this UI's disabling is convenience, not
// the trust boundary, so a crafted client cannot escalate by re-enabling a button.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addAllowedEmail,
  addSystemProvider,
  activateSystemProvider,
  clearSystemLifeboat,
  listSystemProviders,
  listUsers,
  removeAllowedEmail,
  removeUser,
  setSystemLifeboat,
  setUserRole,
  type Credential,
  type NewCredential,
  type User,
} from "@/lib/gateway";

// Seeded sentinel accounts that must never be demoted or deleted from the UI:
// the human's real data-holding account (…001) and the system-config owner whose
// provider rows ARE the system-wide config (…002).
const DEV_UID = "00000000-0000-0000-0000-000000000001";
const SYSTEM_CONFIG_UID = "00000000-0000-0000-0000-000000000002";

const PROVIDER_LABEL: Record<Credential["provider"], string> = {
  anthropic: "Claude (Anthropic)",
  openai_compat: "OpenRouter",
  local: "Local (Ollama)",
};

// Pure guard for the per-user row actions. Protected sentinels are frozen, and the
// LAST remaining admin can neither be demoted nor removed (the system must always
// keep at least one admin). Exported so the logic is checkable in isolation.
export function userGuards(
  users: User[],
  u: User,
): { canToggleRole: boolean; canRemove: boolean; reason?: string } {
  if (u.id === DEV_UID || u.id === SYSTEM_CONFIG_UID) {
    return { canToggleRole: false, canRemove: false, reason: "Protected account" };
  }
  const admins = users.filter((x) => x.role === "admin").length;
  const isLastAdmin = u.role === "admin" && admins <= 1;
  if (isLastAdmin) {
    return { canToggleRole: false, canRemove: false, reason: "Last admin" };
  }
  return { canToggleRole: true, canRemove: true };
}

export default function Admin({
  token,
  onFail,
}: {
  token: string;
  onFail: (e: unknown) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8">
      <div className="mx-auto flex max-w-2xl flex-col gap-10">
        <div>
          <h1 className="text-2xl font-semibold text-on-surface">Admin</h1>
          <p className="mt-2 text-sm text-muted">
            Manage who may sign in, each person&apos;s role, and the system-wide model
            provider everyone inherits. Members configure none of this.
          </p>
        </div>
        <UsersSection token={token} onFail={onFail} />
        <SystemProvidersSection token={token} onFail={onFail} />
      </div>
    </div>
  );
}

// --- users -------------------------------------------------------------------
// ONE list. Active users (a real users row, status !== 'pending') get role +
// last-active + Promote/Demote/Remove. Pending invites (an allowed_emails row
// with no user yet, status === 'pending') get an "invited" tag + a Remove that
// revokes the invite. Adding an email is the invite itself — no mail is sent; it
// is what permits that person to sign in with Google. The server re-checks
// requireAdmin + role on every mutation, so this UI's disabling is convenience.

// Relative "last active" label from an ISO timestamp. Null/absent (a pending
// invite, or an active user never stamped) reads as "—". Exported so the bucket
// boundaries are checkable in isolation.
export function lastActiveLabel(iso?: string | null, now: number = Date.now()): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `active ${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `active ${h}h ago`;
  return `active ${Math.floor(h / 24)}d ago`;
}

function UsersSection({
  token,
  onFail,
}: {
  token: string;
  onFail: (e: unknown) => void;
}) {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");

  const { data: users, error, isPending } = useQuery({
    queryKey: ["admin", "users", token],
    queryFn: () => listUsers(token),
    enabled: !!token,
  });

  // Load failures drive the shell's token refresh (a token change re-keys the
  // query, so a successful refresh refetches automatically).
  useEffect(() => {
    if (error) onFail(error);
  }, [error, onFail]);

  // One mutation for add/role/remove: run the op, then invalidate the whole
  // ["admin"] namespace so both this list and the config refetch canonical state.
  const mutation = useMutation({
    mutationFn: ({ fn }: { key: string; fn: () => Promise<unknown> }) => fn(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin"] }),
    onError: onFail,
  });
  const busy = mutation.isPending ? mutation.variables?.key ?? null : null;
  const run = (key: string, fn: () => Promise<unknown>) => mutation.mutate({ key, fn });
  const errMsg =
    mutation.error instanceof Error
      ? mutation.error.message
      : mutation.error
        ? String(mutation.error)
        : null;

  function add() {
    const e = email.trim().toLowerCase();
    if (!e) return;
    run("__add__", () => addAllowedEmail(token, e));
    setEmail("");
  }

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold text-on-surface">Users</h2>
        <p className="mt-1 text-sm text-muted">
          Everyone with access. Adding an email invites that person to sign in with
          Google; once they do they become a{" "}
          <span className="font-medium text-on-surface">member</span> you can
          promote or remove.
        </p>
      </div>

      {errMsg && (
        <div
          role="alert"
          className="border-l-2 border-error bg-error/10 px-3 py-2 text-sm text-error"
        >
          {errMsg}
        </div>
      )}

      <div className="flex gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="invite person@example.com"
          className="flex-1 rounded-md border border-edge bg-raised px-3 py-1.5 text-sm text-on-surface placeholder:text-faint outline-none transition-colors focus:border-accent"
        />
        <button
          onClick={add}
          disabled={busy === "__add__" || !email.trim()}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong disabled:opacity-40"
        >
          {busy === "__add__" ? "Inviting…" : "Invite"}
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        {isPending && <p className="text-sm text-faint">Loading…</p>}
        {users?.length === 0 && <p className="text-sm text-faint">No users yet.</p>}
        {users?.map((u) => {
          // Pending = an allowlisted email with no user row yet. Its row key is
          // the email (a pending row has no meaningful id); active rows key on id.
          const pending = u.status === "pending";
          if (pending) {
            const key = u.email ?? u.id;
            return (
              <div
                key={key}
                className="flex items-center justify-between rounded-lg border border-dashed border-edge bg-panel px-3 py-2"
              >
                <div className="min-w-0">
                  <span className="truncate text-sm text-on-surface">
                    {u.email ?? u.id}
                  </span>
                  <div className="text-xs text-faint">
                    Invited — hasn&apos;t signed up yet
                  </div>
                </div>
                <button
                  disabled={busy === key}
                  onClick={() =>
                    void run(key, () => removeAllowedEmail(token, u.email ?? ""))
                  }
                  className="shrink-0 rounded-md border border-edge px-2.5 py-1 text-xs text-muted transition-colors hover:bg-raised hover:text-error disabled:opacity-40"
                >
                  Remove
                </button>
              </div>
            );
          }

          const g = userGuards(users, u);
          const isAdmin = u.role === "admin";
          return (
            <div
              key={u.id}
              className="flex items-center justify-between rounded-lg border border-edge bg-panel px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-on-surface">
                    {u.email ?? u.id}
                  </span>
                  <span
                    className={
                      isAdmin
                        ? "rounded-md bg-accent/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-widest text-accent"
                        : "rounded-md bg-raised px-2 py-0.5 text-[10px] font-medium uppercase tracking-widest text-muted"
                    }
                  >
                    {u.role ?? "member"}
                  </span>
                </div>
                <div className="text-xs text-faint">
                  {lastActiveLabel(u.last_active)}
                  {g.reason ? ` · ${g.reason}` : ""}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <button
                  disabled={!g.canToggleRole || busy === u.id}
                  title={g.reason}
                  onClick={() =>
                    void run(u.id, () =>
                      setUserRole(token, u.id, isAdmin ? "member" : "admin"),
                    )
                  }
                  className="rounded-md border border-edge px-2.5 py-1 text-xs text-muted transition-colors hover:bg-raised hover:text-on-surface disabled:opacity-40"
                >
                  {isAdmin ? "Demote" : "Promote"}
                </button>
                <button
                  disabled={!g.canRemove || busy === u.id}
                  title={g.reason}
                  onClick={() => void run(u.id, () => removeUser(token, u.id))}
                  className="rounded-md border border-edge px-2.5 py-1 text-xs text-muted transition-colors hover:bg-raised hover:text-error disabled:opacity-40"
                >
                  Remove
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// --- system providers --------------------------------------------------------
// The system-wide model config, relocated here from the member Settings view.
// Same add/activate/lifeboat controls; the client calls the /api/admin/providers*
// routes, which the gateway roots at the system-config owner. Portability
// (local / OpenRouter / Claude) and the lifeboat fallback are unchanged.

function SystemProvidersSection({
  token,
  onFail,
}: {
  token: string;
  onFail: (e: unknown) => void;
}) {
  const qc = useQueryClient();

  const { data: creds, error, isPending } = useQuery({
    queryKey: ["admin", "providers", token],
    queryFn: () => listSystemProviders(token),
    enabled: !!token,
  });

  useEffect(() => {
    if (error) onFail(error);
  }, [error, onFail]);

  const mutation = useMutation({
    mutationFn: ({ fn }: { id: string; fn: () => Promise<unknown> }) => fn(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin"] }),
    onError: onFail,
  });
  const busy = mutation.isPending ? mutation.variables?.id ?? null : null;
  const run = (id: string, fn: () => Promise<unknown>) => mutation.mutate({ id, fn });
  const errMsg =
    mutation.error instanceof Error
      ? mutation.error.message
      : mutation.error
        ? String(mutation.error)
        : null;

  const lifeboat = creds?.find((c) => c.is_lifeboat);

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold text-on-surface">Model provider</h2>
        <p className="mt-1 text-sm text-muted">
          System-wide. The <span className="font-medium text-on-surface">active</span>{" "}
          provider answers every member&apos;s messages; the{" "}
          <span className="font-medium text-on-surface">fallback</span> takes over only
          if the active credential is rejected, and that reply is marked degraded.
        </p>
      </div>

      {errMsg && (
        <div
          role="alert"
          className="border-l-2 border-error bg-error/10 px-3 py-2 text-sm text-error"
        >
          {errMsg}
        </div>
      )}

      {!lifeboat && creds && creds.length > 0 && (
        <div
          role="status"
          className="border-l-2 border-warning bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          No fallback set. If the active credential is rejected, the assistant stops
          instead of degrading. Designate a local or OpenRouter provider below.
        </div>
      )}

      <div className="flex flex-col gap-2">
        {isPending && <p className="text-sm text-faint">Loading…</p>}
        {creds?.length === 0 && (
          <p className="text-sm text-faint">No providers yet. Add one below.</p>
        )}
        {creds?.map((c) => (
          <div
            key={c.id}
            className="flex items-center justify-between rounded-xl border border-edge bg-panel px-4 py-3"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-on-surface">
                  {PROVIDER_LABEL[c.provider]}
                </span>
                {c.is_active && (
                  <span className="rounded-md bg-accent/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-widest text-accent">
                    Active
                  </span>
                )}
                {c.is_lifeboat && (
                  <span className="rounded-md bg-raised px-2 py-0.5 text-[10px] font-medium uppercase tracking-widest text-muted">
                    Fallback
                  </span>
                )}
              </div>
              <div className="truncate text-xs text-muted">
                {c.model_id} · {c.auth_type}
                {c.base_url ? ` · ${c.base_url}` : ""}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {!c.is_active && (
                <button
                  disabled={busy === c.id}
                  onClick={() => void run(c.id, () => activateSystemProvider(token, c.id))}
                  className="rounded-md border border-edge px-2.5 py-1 text-xs text-muted transition-colors hover:bg-raised hover:text-on-surface disabled:opacity-40"
                >
                  Use this
                </button>
              )}
              {c.is_lifeboat ? (
                <button
                  disabled={busy === c.id}
                  onClick={() => void run(c.id, () => clearSystemLifeboat(token, c.id))}
                  className="rounded-md border border-edge px-2.5 py-1 text-xs text-muted transition-colors hover:bg-raised hover:text-on-surface disabled:opacity-40"
                >
                  Clear fallback
                </button>
              ) : (
                // The active credential can't also be the fallback.
                !c.is_active && (
                  <button
                    disabled={busy === c.id}
                    onClick={() => void run(c.id, () => setSystemLifeboat(token, c.id))}
                    className="rounded-md bg-accent/15 px-2.5 py-1 text-xs text-accent transition-colors hover:bg-accent/25 disabled:opacity-40"
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
          // mutateAsync rejects on error so the form keeps its fields; success
          // invalidates ["admin"] and refetches. The banner shows mutation.error.
          await mutation.mutateAsync({
            id: "__add__",
            fn: () => addSystemProvider(token, cred),
          });
        }}
      />
    </section>
  );
}

// Compact provider form, mirroring the member Settings form it replaces. Local
// (Ollama) / OpenRouter / Claude — provider portability preserved.
function AddProviderForm({
  onAdd,
}: {
  onAdd: (cred: NewCredential) => Promise<void>;
}) {
  const [provider, setProvider] = useState<Credential["provider"]>("openai_compat");
  const [authType, setAuthType] = useState<"api_key" | "oauth">("api_key");
  const [modelId, setModelId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [activate, setActivate] = useState(false);
  const [saving, setSaving] = useState(false);

  const needsBaseUrl = provider === "openai_compat" || provider === "local";
  const oauthAllowed = provider === "anthropic";

  async function submit() {
    if (!modelId.trim() || saving) return;
    setSaving(true);
    try {
      await onAdd({
        provider,
        auth_type: authType,
        api_key: apiKey || undefined,
        base_url: needsBaseUrl && baseUrl ? baseUrl : undefined,
        model_id: modelId.trim(),
        activate,
      });
      setModelId("");
      setBaseUrl("");
      setApiKey("");
      setActivate(false);
    } catch {
      /* error shown by parent */
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-edge bg-panel p-4">
      <h3 className="mb-4 text-base font-semibold text-on-surface">Add a provider</h3>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-widest text-faint">Provider</span>
          <select
            value={provider}
            onChange={(e) => {
              const p = e.target.value as Credential["provider"];
              setProvider(p);
              if (p !== "anthropic" && authType === "oauth") setAuthType("api_key");
            }}
            className="rounded-md border border-edge bg-raised px-2 py-1.5 text-on-surface outline-none transition-colors focus:border-accent"
          >
            <option value="anthropic">Claude (Anthropic)</option>
            <option value="openai_compat">OpenRouter</option>
            <option value="local">Local (Ollama)</option>
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-widest text-faint">Auth</span>
          <select
            value={authType}
            onChange={(e) => setAuthType(e.target.value as "api_key" | "oauth")}
            className="rounded-md border border-edge bg-raised px-2 py-1.5 text-on-surface outline-none transition-colors focus:border-accent"
          >
            <option value="api_key">API key</option>
            {oauthAllowed && <option value="oauth">OAuth (Claude subscription)</option>}
          </select>
        </label>

        <label className="col-span-2 flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-widest text-faint">Model</span>
          <input
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            placeholder={
              provider === "anthropic"
                ? "claude-opus-4-8"
                : provider === "local"
                  ? "qwen2.5:7b"
                  : "meta-llama/llama-3.1-70b-instruct"
            }
            className="rounded-md border border-edge bg-raised px-2 py-1.5 text-on-surface placeholder:text-faint outline-none transition-colors focus:border-accent"
          />
        </label>

        {needsBaseUrl && (
          <label className="col-span-2 flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-widest text-faint">
              Base URL {provider === "local" && "(blank = deployment default)"}
            </span>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={
                provider === "local" ? "http://ollama:11434/v1" : "https://openrouter.ai/api/v1"
              }
              className="rounded-md border border-edge bg-raised px-2 py-1.5 text-on-surface placeholder:text-faint outline-none transition-colors focus:border-accent"
            />
          </label>
        )}

        {authType === "api_key" && provider !== "local" && (
          <label className="col-span-2 flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-widest text-faint">API key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="stored encrypted; never shown again"
              className="rounded-md border border-edge bg-raised px-2 py-1.5 text-on-surface placeholder:text-faint outline-none transition-colors focus:border-accent"
            />
          </label>
        )}

        <label className="col-span-2 flex items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={activate}
            onChange={(e) => setActivate(e.target.checked)}
          />
          Make this the active provider
        </label>
      </div>

      <button
        onClick={() => void submit()}
        disabled={saving || !modelId.trim()}
        className="mt-4 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong disabled:opacity-40"
      >
        {saving ? "Adding…" : "Add provider"}
      </button>
    </div>
  );
}
