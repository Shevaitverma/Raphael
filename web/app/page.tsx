"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  activateProvider,
  addProvider,
  clearLifeboat,
  createConversation,
  devLogin,
  getCapabilities,
  getProfile,
  isAuthError,
  listConversations,
  listMessages,
  listProviders,
  setLifeboat,
  streamChat,
  updateProfile,
  type Conversation,
  type Credential,
  type Degraded,
  type Message,
  type NewCredential,
  type User,
} from "@/lib/gateway";

const DEV_EMAIL = "dev@raphael.local";
const SEARCH_KEY = "raphael.search";

// UI message carries extra render state that never touches the database.
type UiMessage = Message & {
  // Client-side identity, assigned before the row has a database id. Streaming
  // patches address the message by this, never by its index: any reload can
  // replace the array and leave an index pointing at a different message.
  localId?: string;
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
  const [error, setError] = useState<string | null>(null);

  const [view, setView] = useState<"chat" | "settings">("chat");

  // Display-only assistant name. Defaults to the product name until the profile
  // loads; the system-prompt name is set server-side and never sent from here.
  const [assistantName, setAssistantName] = useState("Raphael");

  // The toggle is the only gate on search, so it must survive a reload — but a
  // sticky true means nothing if this deployment has no search key, hence both
  // flags. searchOn, never `search` alone, is what reaches the wire.
  const [search, setSearch] = useState(false);
  const [searchAvailable, setSearchAvailable] = useState(false);
  const searchOn = search && searchAvailable;

  const threadRef = useRef<HTMLDivElement>(null);
  // The in-flight chat stream, so switching conversations, signing out, or
  // pressing Stop can cut it loose. The gateway never times a stream out.
  const abortRef = useRef<AbortController | null>(null);
  // A conversation we just created: the load effect must skip it exactly once.
  const skipLoadRef = useRef<string | null>(null);

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

  const handleLogout = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setToken(null);
    setUser(null);
    setConversations([]);
    setActiveId(null);
    setMessages([]);
    setSending(false);
    setError(null);
    setAssistantName("Raphael");
  }, []);

  // Every /api call funnels its failure here: an expired token ends the session,
  // anything else gets shown. Nothing is allowed to die in the console — a dead
  // backend used to be indistinguishable from an empty account.
  const failed = useCallback(
    (e: unknown) => {
      if (isAuthError(e)) {
        handleLogout();
        setAuthError("Your session expired. Sign in again.");
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
    },
    [handleLogout],
  );

  // --- search toggle ---------------------------------------------------------

  // localStorage does not exist during the server render, so read it in an
  // effect rather than a useState initializer.
  useEffect(() => {
    setSearch(localStorage.getItem(SEARCH_KEY) === "1");
  }, []);

  // A checkbox that silently does nothing is the invisible failure this whole
  // feature must not have. No key -> no toggle, with the reason said out loud.
  useEffect(() => {
    if (!token) return;
    let live = true;
    getCapabilities(token)
      .then((c) => live && setSearchAvailable(c.web_search))
      .catch(() => live && setSearchAvailable(false));
    return () => {
      live = false;
    };
  }, [token]);

  // Load the display name once signed in. A failure keeps the "Raphael" default
  // and surfaces through the same banner as everything else — never swallowed.
  useEffect(() => {
    if (!token) return;
    let live = true;
    getProfile(token)
      .then((p) => {
        if (live && p.assistant_name) setAssistantName(p.assistant_name);
      })
      .catch((e) => {
        if (live) failed(e);
      });
    return () => {
      live = false;
    };
  }, [token, failed]);

  function toggleSearch(on: boolean) {
    setSearch(on);
    localStorage.setItem(SEARCH_KEY, on ? "1" : "0");
  }

  // --- conversations ---------------------------------------------------------

  const refreshConversations = useCallback(async () => {
    if (!token) return;
    try {
      const convs = await listConversations(token);
      setConversations(convs);
      setError(null);
      if (convs.length > 0 && activeId === null) {
        setActiveId(convs[0].id);
      }
    } catch (e) {
      failed(e);
    }
  }, [token, activeId, failed]);

  useEffect(() => {
    if (token) void refreshConversations();
  }, [token, refreshConversations]);

  const loadMessages = useCallback(
    async (conversationId: string) => {
      if (!token) return;
      try {
        const msgs = await listMessages(token, conversationId);
        setMessages(msgs);
        setError(null);
      } catch (e) {
        // Clear rather than leave the previous conversation's messages under
        // this one's header. The banner below says why the thread is empty —
        // silently blanking it is what made a dead backend look like no data.
        setMessages([]);
        failed(e);
      }
    },
    [token, failed],
  );

  useEffect(() => {
    if (!token || !activeId) return;
    // A conversation we just created holds only the optimistic messages already
    // on screen. Loading it would replace them mid-stream and drop the reply.
    if (skipLoadRef.current === activeId) {
      skipLoadRef.current = null;
      return;
    }
    void loadMessages(activeId);
    // Cleanup only registers once a conversation is actually being viewed, so
    // the null -> new-conversation transition in handleSend cannot abort the
    // stream it is about to start. Switching away from a live one does.
    return () => abortRef.current?.abort();
  }, [token, activeId, loadMessages]);

  async function handleNewConversation() {
    if (!token) return;
    try {
      const conv = await createConversation(token);
      setConversations((prev) => [conv, ...prev]);
      skipLoadRef.current = conv.id;
      setActiveId(conv.id);
      setMessages([]);
      setError(null);
    } catch (e) {
      failed(e);
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
        // Claim the load skip before activeId changes, or the effect fires and
        // replaces the optimistic messages below with the server's empty list.
        skipLoadRef.current = conv.id;
        setActiveId(conv.id);
        conversationId = conv.id;
      } catch (e) {
        failed(e);
        return;
      }
    }

    setDraft("");
    setError(null);
    setSending(true);

    // Optimistic user message + a placeholder assistant message we stream into,
    // addressed by a stable id: a patch aimed at an index would land on whatever
    // message happened to occupy that slot.
    const localId = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      { role: "user", content: text },
      { localId, role: "assistant", content: "", streaming: true },
    ]);

    const patchAssistant = (patch: Partial<UiMessage>) => {
      setMessages((prev) =>
        prev.map((m) => (m.localId === localId ? { ...m, ...patch } : m)),
      );
    };

    const appendToken = (t: string) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.localId === localId ? { ...m, content: m.content + t } : m,
        ),
      );
    };

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    await streamChat(
      token,
      { conversation_id: conversationId, message: text, search: searchOn },
      {
        onToken: (t) => appendToken(t),
        onDegraded: (d) => patchAssistant({ degraded: d }),
        // Keep the row's database id so it stops being identified by position.
        onDone: (d) => patchAssistant({ streaming: false, id: d.message_id }),
        onError: (message) => patchAssistant({ streaming: false, error: message }),
      },
      ctrl.signal,
    );

    // An abort leaves the placeholder mid-stream. If the user has since moved to
    // another conversation, localId matches nothing and this is a no-op.
    if (ctrl.signal.aborted) patchAssistant({ streaming: false });

    if (abortRef.current === ctrl) abortRef.current = null;
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
        <SettingsView token={token} assistantName={assistantName} onSaved={setAssistantName} />
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
            {conversations.length === 0 && !error && (
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
          {error && (
            <div
              role="alert"
              className="border-b border-error/40 bg-error/10 px-4 py-2 text-sm text-error"
            >
              {error}
            </div>
          )}
          <div
            ref={threadRef}
            aria-live="polite"
            className="min-h-0 flex-1 overflow-y-auto px-4 py-6"
          >
            <div className="mx-auto flex max-w-3xl flex-col space-y-6">
              {messages.length === 0 && !error && (
                <p className="py-16 text-center text-sm text-faint">
                  Send a message to start.
                </p>
              )}
              {messages.map((m, i) => (
                <MessageRow key={m.id ?? m.localId ?? i} message={m} assistantName={assistantName} />
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
                placeholder={`Message ${assistantName}…`}
                className="max-h-40 min-h-[44px] flex-1 resize-none bg-transparent px-3 py-2 text-sm text-on-surface placeholder:text-faint outline-none"
              />
              {/* A stream can hang with no reply and no timeout; Stop is the
                  only way out that does not cost the in-memory session. */}
              {sending ? (
                <button
                  onClick={() => abortRef.current?.abort()}
                  className="rounded-md border border-edge px-4 py-2 text-sm font-medium text-muted transition-colors hover:bg-raised hover:text-on-surface"
                >
                  Stop
                </button>
              ) : (
                <button
                  onClick={() => void handleSend()}
                  disabled={draft.trim().length === 0}
                  className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong disabled:opacity-40"
                >
                  Send
                </button>
              )}
            </div>

            <div className="mx-auto mt-2 flex max-w-3xl items-center gap-2 text-xs">
              <input
                id="web-search"
                type="checkbox"
                checked={searchOn}
                disabled={!searchAvailable}
                onChange={(e) => toggleSearch(e.target.checked)}
                className="accent-accent disabled:opacity-40"
              />
              <label
                htmlFor="web-search"
                className={searchAvailable ? "text-muted" : "text-faint"}
              >
                Search the web (sends your question to a search provider)
              </label>
              {!searchAvailable && (
                <span className="text-faint">
                  — search is not available on this deployment
                </span>
              )}
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

function SettingsView({
  token,
  assistantName,
  onSaved,
}: {
  token: string;
  assistantName: string;
  onSaved: (name: string) => void;
}) {
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
        <AssistantNameForm token={token} assistantName={assistantName} onSaved={onSaved} />

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

function AssistantNameForm({
  token,
  assistantName,
  onSaved,
}: {
  token: string;
  assistantName: string;
  onSaved: (name: string) => void;
}) {
  const [name, setName] = useState(assistantName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Keep the field in step with the loaded/lifted name (the profile fetch may
  // land after this panel mounts, and a save lifts the canonical value back).
  useEffect(() => {
    setName(assistantName);
  }, [assistantName]);

  const trimmed = name.trim();
  const dirty = trimmed !== assistantName;

  async function save() {
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const p = await updateProfile(token, trimmed);
      onSaved(p.assistant_name); // lift so the chat UI updates without a reload
      setName(p.assistant_name);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-edge bg-panel p-4">
      <h3 className="mb-1 text-base font-semibold text-on-surface">
        Assistant name
      </h3>
      <p className="mb-4 text-sm text-muted">
        The name shown on the assistant&apos;s messages and in the composer.
      </p>

      {error && (
        <div
          role="alert"
          className="mb-3 border-l-2 border-error bg-error/10 px-3 py-2 text-sm text-error"
        >
          {error}
        </div>
      )}

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-[11px] uppercase tracking-widest text-faint">Name</span>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setSaved(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            }
          }}
          maxLength={40}
          placeholder="Raphael"
          className="rounded-md border border-edge bg-raised px-2 py-1.5 text-on-surface placeholder:text-faint outline-none transition-colors focus:border-accent"
        />
      </label>

      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={() => void save()}
          disabled={saving || !trimmed || !dirty}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && !dirty && (
          <span role="status" className="text-xs text-muted">
            Saved.
          </span>
        )}
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

function MessageRow({
  message,
  assistantName,
}: {
  message: UiMessage;
  assistantName: string;
}) {
  const isUser = message.role === "user";
  // Avatar initial tracks the name; fall back to the product initial if blank.
  const botInitial = (assistantName.trim()[0] ?? "R").toUpperCase();

  return (
    <div className="flex gap-3">
      {/* Avatar */}
      <div
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
          isUser ? "bg-raised text-muted" : "bg-accent/20 text-accent"
        }`}
      >
        {isUser ? "Y" : botInitial}
      </div>

      <div className="min-w-0 flex-1">
        {/* Name + timestamp line */}
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-on-surface">
            {isUser ? "you" : assistantName}
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
          <div
            role="status"
            className="mt-2 border-l-2 border-warning bg-warning/10 px-3 py-2 text-xs text-warning"
          >
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
          <div
            role="alert"
            className="mt-2 border-l-2 border-error bg-error/10 px-3 py-2 text-xs text-error"
          >
            {message.error}
          </div>
        )}
      </div>
    </div>
  );
}
