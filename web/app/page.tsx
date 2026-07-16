"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  activateProvider,
  addProvider,
  clearLifeboat,
  createConversation,
  devLogin,
  listConversations,
  listMessages,
  listProviders,
  setLifeboat,
  streamChat,
  type Conversation,
  type Credential,
  type Degraded,
  type Message,
  type NewCredential,
  type User,
} from "@/lib/gateway";

const DEV_EMAIL = "dev@raphael.local";

// UI message carries extra render state that never touches the database.
type UiMessage = Message & {
  degraded?: Degraded;
  error?: string;
  streaming?: boolean;
};

export default function Page() {
  // JWT lives in memory only — never localStorage (product requirement).
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const [view, setView] = useState<"chat" | "settings">("chat");

  const threadRef = useRef<HTMLDivElement>(null);

  // --- auth ------------------------------------------------------------------

  async function handleLogin() {
    setLoggingIn(true);
    setAuthError(null);
    try {
      const res = await devLogin(DEV_EMAIL);
      setToken(res.token);
      setUser(res.user);
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoggingIn(false);
    }
  }

  function handleLogout() {
    setToken(null);
    setUser(null);
    setConversations([]);
    setActiveId(null);
    setMessages([]);
  }

  // --- conversations ---------------------------------------------------------

  const refreshConversations = useCallback(async () => {
    if (!token) return;
    try {
      const convs = await listConversations(token);
      setConversations(convs);
      if (convs.length > 0 && activeId === null) {
        setActiveId(convs[0].id);
      }
    } catch (e) {
      console.error(e);
    }
  }, [token, activeId]);

  useEffect(() => {
    if (token) void refreshConversations();
  }, [token, refreshConversations]);

  const loadMessages = useCallback(
    async (conversationId: string) => {
      if (!token) return;
      try {
        const msgs = await listMessages(token, conversationId);
        setMessages(msgs);
      } catch (e) {
        console.error(e);
        setMessages([]);
      }
    },
    [token],
  );

  useEffect(() => {
    if (token && activeId) void loadMessages(activeId);
  }, [token, activeId, loadMessages]);

  async function handleNewConversation() {
    if (!token) return;
    try {
      const conv = await createConversation(token);
      setConversations((prev) => [conv, ...prev]);
      setActiveId(conv.id);
      setMessages([]);
    } catch (e) {
      console.error(e);
    }
  }

  // Auto-scroll the thread as tokens arrive.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // --- sending / streaming ---------------------------------------------------

  async function handleSend() {
    const text = draft.trim();
    if (!token || !text || sending) return;

    let conversationId = activeId;
    if (!conversationId) {
      try {
        const conv = await createConversation(token);
        setConversations((prev) => [conv, ...prev]);
        setActiveId(conv.id);
        conversationId = conv.id;
      } catch (e) {
        console.error(e);
        return;
      }
    }

    setDraft("");
    setSending(true);

    // Optimistic user message + a placeholder assistant message we stream into.
    const assistantIndex = messages.length + 1;
    setMessages((prev) => [
      ...prev,
      { role: "user", content: text },
      { role: "assistant", content: "", streaming: true },
    ]);

    const patchAssistant = (patch: Partial<UiMessage>) => {
      setMessages((prev) => {
        const next = [...prev];
        const cur = next[assistantIndex];
        if (cur) next[assistantIndex] = { ...cur, ...patch };
        return next;
      });
    };

    const appendToken = (t: string) => {
      setMessages((prev) => {
        const next = [...prev];
        const cur = next[assistantIndex];
        if (cur) next[assistantIndex] = { ...cur, content: cur.content + t };
        return next;
      });
    };

    await streamChat(
      token,
      { conversation_id: conversationId, message: text },
      {
        onToken: (t) => appendToken(t),
        onDegraded: (d) => patchAssistant({ degraded: d }),
        onDone: () => patchAssistant({ streaming: false }),
        onError: (message) => patchAssistant({ streaming: false, error: message }),
      },
    );

    setSending(false);
    // Pull the canonical conversation title / list back from the server.
    void refreshConversations();
  }

  // --- render ----------------------------------------------------------------

  if (!token) {
    return <LoginScreen onLogin={handleLogin} loading={loggingIn} error={authError} />;
  }

  return (
    <div className="flex h-screen flex-col bg-surface font-sans text-on-surface">
      <header className="z-10 flex items-center justify-between border-b border-edge bg-panel px-4 py-3">
        <div className="flex items-center gap-5">
          <h1 className="text-lg font-semibold tracking-tight text-accent">
            Raphael
          </h1>
          <nav className="flex items-center gap-1 text-sm">
            {(["chat", "settings"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`rounded-md px-3.5 py-1 capitalize transition-colors ${
                  view === v
                    ? "bg-raised font-medium text-on-surface"
                    : "text-muted hover:text-on-surface"
                }`}
              >
                {v}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3 text-sm text-muted">
          <span>{user?.email ?? user?.id}</span>
          <button
            onClick={handleLogout}
            className="rounded-md border border-edge px-2.5 py-1 text-xs text-muted transition-colors hover:bg-raised hover:text-on-surface"
          >
            Sign out
          </button>
        </div>
      </header>

      {view === "settings" ? (
        <SettingsView token={token} />
      ) : (
      <div className="flex min-h-0 flex-1">
        {/* Conversation list */}
        <aside className="flex w-64 flex-col border-r border-edge bg-panel">
          <button
            onClick={handleNewConversation}
            className="m-3 rounded-md bg-accent/15 px-3 py-1.5 text-sm font-medium text-accent transition-colors hover:bg-accent/25"
          >
            + New conversation
          </button>
          <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {conversations.length === 0 && (
              <p className="px-2 py-3 text-sm text-faint">
                No conversations yet.
              </p>
            )}
            {conversations.map((c) => (
              <button
                key={c.id}
                onClick={() => setActiveId(c.id)}
                className={`mb-1 block w-full truncate rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  c.id === activeId
                    ? "bg-raised text-on-surface"
                    : "text-muted hover:bg-raised/60 hover:text-on-surface"
                }`}
                title={c.title ?? c.id}
              >
                {c.title?.trim() || "Untitled"}
              </button>
            ))}
          </nav>
        </aside>

        {/* Thread + composer */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div ref={threadRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
            <div className="mx-auto flex max-w-3xl flex-col space-y-6">
              {messages.length === 0 && (
                <p className="py-16 text-center text-sm text-faint">
                  Send a message to start.
                </p>
              )}
              {messages.map((m, i) => (
                <MessageRow key={m.id ?? i} message={m} />
              ))}
            </div>
          </div>

          <div className="border-t border-edge px-4 py-3">
            <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-xl border border-edge bg-raised p-2 transition-colors focus-within:border-accent">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                rows={1}
                placeholder="Message Raphael…"
                className="max-h-40 min-h-[44px] flex-1 resize-none bg-transparent px-3 py-2 text-sm text-on-surface placeholder:text-faint outline-none"
              />
              <button
                onClick={() => void handleSend()}
                disabled={sending || draft.trim().length === 0}
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong disabled:opacity-40"
              >
                {sending ? "…" : "Send"}
              </button>
            </div>
          </div>
        </main>
      </div>
      )}
    </div>
  );
}

function LoginScreen({
  onLogin,
  loading,
  error,
}: {
  onLogin: () => void;
  loading: boolean;
  error: string | null;
}) {
  return (
    <div className="flex h-screen flex-col items-center justify-center bg-surface px-4 font-sans text-on-surface">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-xl border border-edge bg-panel px-8 py-10 text-center">
        <h1 className="font-display text-3xl font-semibold tracking-wide text-accent">
          Raphael
        </h1>
        <p className="text-[11px] uppercase tracking-widest text-faint">
          Dev mode — sign in as {DEV_EMAIL}
        </p>
        <button
          onClick={onLogin}
          disabled={loading}
          className="mt-2 w-full rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong disabled:opacity-40"
        >
          {loading ? "Signing in…" : "Dev login"}
        </button>
        {error && (
          <p className="max-w-md text-center text-sm text-error">{error}</p>
        )}
      </div>
    </div>
  );
}

// --- settings: model providers + lifeboat designation ----------------------

const PROVIDER_LABEL: Record<Credential["provider"], string> = {
  anthropic: "Claude (Anthropic)",
  openai_compat: "OpenRouter",
  local: "Local (Ollama)",
};

function SettingsView({ token }: { token: string }) {
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
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <div>
          <h2 className="text-2xl font-semibold text-on-surface">
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
          <div className="border-l-2 border-error bg-error/10 px-3 py-2 text-sm text-error">
            {error}
          </div>
        )}

        {!lifeboat && creds && creds.length > 0 && (
          <div className="border-l-2 border-warning bg-warning/10 px-3 py-2 text-sm text-warning">
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
              className="flex items-center justify-between rounded-xl border border-edge bg-panel px-4 py-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-on-surface">{PROVIDER_LABEL[c.provider]}</span>
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
                    onClick={() => void run(c.id, () => activateProvider(token, c.id))}
                    className="rounded-md border border-edge px-2.5 py-1 text-xs text-muted transition-colors hover:bg-raised hover:text-on-surface disabled:opacity-40"
                  >
                    Use this
                  </button>
                )}
                {c.is_lifeboat ? (
                  <button
                    disabled={busy === c.id}
                    onClick={() => void run(c.id, () => clearLifeboat(token, c.id))}
                    className="rounded-md border border-edge px-2.5 py-1 text-xs text-muted transition-colors hover:bg-raised hover:text-on-surface disabled:opacity-40"
                  >
                    Clear fallback
                  </button>
                ) : (
                  // The active credential can't also be the fallback.
                  !c.is_active && (
                    <button
                      disabled={busy === c.id}
                      onClick={() => void run(c.id, () => setLifeboat(token, c.id))}
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
      </div>
    </div>
  );
}

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
      <h3 className="mb-4 text-base font-semibold text-on-surface">
        Add a provider
      </h3>
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

function MessageRow({ message }: { message: UiMessage }) {
  const isUser = message.role === "user";

  return (
    <div className="flex gap-3">
      {/* Avatar */}
      <div
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
          isUser ? "bg-raised text-muted" : "bg-accent/20 text-accent"
        }`}
      >
        {isUser ? "Y" : "R"}
      </div>

      <div className="min-w-0 flex-1">
        {/* Name + timestamp line */}
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-on-surface">
            {isUser ? "you" : "raphael"}
          </span>
          {message.created_at && (
            <span className="text-xs text-muted">
              {new Date(message.created_at).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          )}
        </div>

        <div className="mt-1 whitespace-pre-wrap text-sm text-on-surface">
          {message.content}
          {message.streaming && !message.content && (
            <span className="text-muted">…</span>
          )}
        </div>

        {/* Degraded banner — the lifeboat fired. Product requirement. */}
        {message.degraded && (
          <div className="mt-2 border-l-2 border-warning bg-warning/10 px-3 py-2 text-xs text-warning">
            Answered by local{" "}
            <span className="font-semibold">
              {message.degraded.model || message.degraded.provider}
            </span>{" "}
            — your Claude credential was rejected
            {message.degraded.reason ? ` (${message.degraded.reason})` : ""}.
          </div>
        )}

        {/* Error state. */}
        {message.error && (
          <div className="mt-2 border-l-2 border-error bg-error/10 px-3 py-2 text-xs text-error">
            {message.error}
          </div>
        )}
      </div>
    </div>
  );
}
