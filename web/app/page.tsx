"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Admin from "./Admin";
import Dashboard from "./Dashboard";
import MemoryGraph from "./MemoryGraph";
import Reminders from "./Reminders";
import Sidebar, { type View } from "./Sidebar";
import Tasks from "./Tasks";
import {
  activateProvider,
  addProvider,
  ApiError,
  clearLifeboat,
  connectGoogle,
  createConversation,
  deleteConversation,
  devLogin,
  disconnectGoogle,
  fetchSession,
  getCapabilities,
  getNotifications,
  getProfile,
  googleLogin,
  googleStatus,
  isAuthError,
  listConversations,
  listMessages,
  listProviders,
  logout,
  markNotificationRead,
  setLifeboat,
  setTimezone,
  storedDegraded,
  streamChat,
  updateProfile,
  type Conversation,
  type Credential,
  type Degraded,
  type GoogleStatus,
  type Message,
  type NewCredential,
  type Notification,
  type User,
} from "@/lib/gateway";

// Persisted timezone reconciliation (client-side; the server has no tz getter).
// TZ_SEEN = the browser tz we last auto-stamped, so app-load auto-detect fires
// only when the browser's own tz actually changes (never clobbering a manual
// Settings choice). TZ_VALUE = the last tz we sent, for the Settings picker.
const TZ_SEEN = "raphael.tz.seen";
const TZ_VALUE = "raphael.tz.value";

function detectedTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const DEV_EMAIL = "dev@raphael.local";
const SEARCH_KEY = "raphael.search";

// Dev-login is a local/dev convenience only. It shows in the UI solely when this
// build was compiled with NEXT_PUBLIC_DEV_AUTH=1; production builds omit the env
// var, so the dev button never renders and Google is the only door.
const DEV_AUTH = process.env.NEXT_PUBLIC_DEV_AUTH === "1";

// UI message carries extra render state that never touches the database. It
// overrides Message.degraded (a stored boolean) with the live Degraded object
// the banner renders — loadMessages rebuilds that object from stored state so
// live and reloaded rows are indistinguishable.
type UiMessage = Omit<Message, "degraded"> & {
  // Client-side identity, assigned before the row has a database id. Streaming
  // patches address the message by this, never by its index: any reload can
  // replace the array and leave an index pointing at a different message.
  localId?: string;
  degraded?: Degraded;
  error?: string;
  streaming?: boolean;
  // Per-turn token cost from the done event. Render-only, never persisted;
  // undefined when the server didn't report it (so the footnote stays hidden).
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
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

  // Dashboard is the post-login/onboarding landing. The Google OAuth round-trip
  // still forces "settings" in its effect below.
  const [view, setView] = useState<View>("dashboard");

  // Result of a Google OAuth round-trip (the gateway redirects back with
  // ?google=connected|error). `googleReload` bumps to re-fetch the connection
  // status after a successful connect.
  const [googleNotice, setGoogleNotice] = useState<{ ok: boolean; msg: string } | null>(null);
  const [googleReload, setGoogleReload] = useState(0);

  // Display-only assistant name. Defaults to the product name until the profile
  // loads; the system-prompt name is set server-side and never sent from here.
  const [assistantName, setAssistantName] = useState("Raphael");

  // null = not yet known (profile still loading / failed). We only show the
  // onboarding screen once we KNOW it's false, so it never flashes on load and
  // a failed profile fetch fails open (stays null → straight into the app).
  const [onboarded, setOnboarded] = useState<boolean | null>(null);

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

  // Google Sign-In IS the login. googleLogin() navigates the browser to Google's
  // consent screen on success, so we only clear `loggingIn` on failure — a
  // success means we're already gone. The callback bounces back with ?login=ok
  // (handled by the effect below) or ?login=denied (uninvited — fail closed).
  async function handleGoogleLogin() {
    setLoggingIn(true);
    setAuthError(null);
    try {
      await googleLogin();
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : String(e));
      setLoggingIn(false);
    }
  }

  // Dev-only backdoor, gated to builds with NEXT_PUBLIC_DEV_AUTH=1. The response
  // carries the role the gateway assigned, so setUser is enough to drive the
  // admin-gated UI below.
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
    void logout(); // revoke the durable session server-side (best-effort)
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
    // The server flag is the source of truth; drop it so a re-login re-checks.
    setOnboarded(null);
  }, []);

  // Every /api call funnels its failure here. On a 401 the short-lived access JWT
  // has expired — before dropping to the login screen, try ONCE to mint a fresh
  // one from the durable session cookie (/auth/session). Success re-arms the
  // in-memory token (effects keyed on `token` re-fire and the view self-heals);
  // only when that ALSO fails is the durable session truly gone -> log out.
  // ponytail: refreshes the token, not the exact failed call; the token-keyed
  // effects re-run, so a read self-heals. Add per-call retry if a mutation must
  // survive an expiry mid-flight.
  // Single-flight the refresh: when the access JWT expires the whole dashboard
  // 401s at once; without this each failed call fires its own /auth/session and
  // the burst trips the rate limiter. Share one in-flight refresh instead.
  const refreshing = useRef<Promise<void> | null>(null);
  const failed = useCallback(
    (e: unknown) => {
      if (isAuthError(e)) {
        if (!refreshing.current) {
          refreshing.current = fetchSession()
            .then((s) => {
              setToken(s.token);
              setUser(s.user);
            })
            .catch(() => {
              handleLogout();
              setAuthError("Your session expired. Sign in again.");
            })
            .finally(() => {
              refreshing.current = null;
            });
        }
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

  // Session restore. Runs once on EVERY mount (fresh load, page refresh, or the
  // return from a Google/dev login), before a token exists, so it drives the
  // initial LoginScreen. The durable httpOnly session cookie is the credential:
  // /auth/session trades it for a fresh in-memory access JWT. A 401 means no
  // valid session -> stay on the login screen silently (this is the normal
  // logged-out case, not an error). ?login=denied (uninvited — fail closed) is
  // the one branch that shows a message instead of attempting a restore.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const login = params.get("login");
    const stripLogin = () => {
      if (!login) return;
      params.delete("login");
      const qs = params.toString();
      window.history.replaceState(
        {},
        "",
        qs ? `${window.location.pathname}?${qs}` : window.location.pathname,
      );
    };

    if (login === "denied") {
      setAuthError(
        "You're not on the invite list yet. Ask an admin to add your email, then sign in again.",
      );
      stripLogin();
      return;
    }

    fetchSession()
      .then((s) => {
        setToken(s.token);
        setUser(s.user); // s.user.role drives the admin-gated UI
      })
      .catch(() => {
        /* no valid session cookie — remain on the login screen */
      })
      .finally(stripLogin);
  }, []);

  // The gateway redirects the browser back here after Google consent. Read the
  // result once, open Settings so it's visible, then strip the query param via
  // replaceState so a reload doesn't re-fire the notice.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const g = params.get("google");
    if (!g) return;
    if (g === "connected") {
      setGoogleNotice({ ok: true, msg: "Google connected." });
      setGoogleReload((n) => n + 1); // re-fetch status in Settings
    } else {
      setGoogleNotice({ ok: false, msg: "Google connection failed. Please try again." });
    }
    setView("settings");
    params.delete("google");
    const qs = params.toString();
    window.history.replaceState(
      {},
      "",
      qs ? `${window.location.pathname}?${qs}` : window.location.pathname,
    );
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

  // Load the display name + onboarding flag once signed in. A failure keeps the
  // "Raphael" default, surfaces through the same banner as everything else, and
  // fails OPEN on the onboarding gate: marking onboarded true lets the user into
  // the app rather than stranding them on a naming screen that never loaded.
  useEffect(() => {
    if (!token) return;
    let live = true;
    getProfile(token)
      .then((p) => {
        if (!live) return;
        if (p.assistant_name) setAssistantName(p.assistant_name);
        setOnboarded(p.onboarded);
      })
      .catch((e) => {
        if (!live) return;
        setOnboarded(true); // fail open — never lock someone out of their app
        failed(e);
      });
    return () => {
      live = false;
    };
  }, [token, failed]);

  // Auto-stamp the browser timezone so reminders fire in the right zone. Cron is
  // evaluated in users.timezone server-side; the model never sets it. The guard
  // sends the PUT only when this browser's tz differs from the one we last
  // stamped — skipping redundant writes AND leaving a manual Settings choice
  // untouched unless the browser's own tz actually changed (e.g. travel).
  useEffect(() => {
    if (!token) return;
    const tz = detectedTz();
    if (localStorage.getItem(TZ_SEEN) === tz) return;
    setTimezone(token, tz)
      .then(() => {
        localStorage.setItem(TZ_SEEN, tz);
        localStorage.setItem(TZ_VALUE, tz);
      })
      .catch(failed);
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
        // Rebuild the live Degraded shape from stored provenance so a reloaded
        // lifeboat answer renders the SAME banner it did while streaming.
        setMessages(msgs.map((m) => ({ ...m, degraded: storedDegraded(m) })));
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

  // Two-step inline confirm: the trash icon arms this, a second click deletes.
  // Cheaper than a modal and never fires on one stray click.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Bulk delete: a selection mode reveals a checkbox per row; the selected ids
  // live in a Set. confirmBulk is the same two-step arm as the single delete.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);

  const allSelected = conversations.length > 0 && selected.size === conversations.length;

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected(allSelected ? new Set() : new Set(conversations.map((c) => c.id)));
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelected(new Set());
    setConfirmBulk(false);
  }

  // Loop the existing single-delete route — N is small for a personal app, so a
  // batch endpoint is a future optimization, not now. Tolerate partial failure:
  // one 404/500 is recorded and the rest still run, then surfaced via failed().
  async function handleDeleteSelected() {
    if (!token || selected.size === 0) return;
    setConfirmBulk(false);
    const deleted = new Set<string>();
    let lastError: unknown = null;
    for (const id of selected) {
      try {
        await deleteConversation(token, id);
        deleted.add(id);
      } catch (e) {
        lastError = e;
      }
    }
    const remaining = conversations.filter((c) => !deleted.has(c.id));
    setConversations(remaining);
    // Don't strand the user on a thread that no longer exists: pick another
    // conversation, or fall back to the empty "start a conversation" state.
    if (activeId && deleted.has(activeId)) {
      const next = remaining[0]?.id ?? null;
      setActiveId(next);
      if (!next) setMessages([]);
    }
    exitSelectMode();
    if (lastError) failed(lastError);
    else {
      setError(null);
      void refreshConversations();
    }
  }

  async function handleDeleteConversation(id: string) {
    if (!token) return;
    setConfirmDeleteId(null);
    try {
      await deleteConversation(token, id);
      const remaining = conversations.filter((c) => c.id !== id);
      setConversations(remaining);
      // Don't strand the user on a thread that no longer exists: pick another
      // conversation, or fall back to the empty "start a conversation" state.
      if (activeId === id) {
        const next = remaining[0]?.id ?? null;
        setActiveId(next);
        if (!next) setMessages([]);
      }
      setError(null);
    } catch (e) {
      failed(e);
    }
  }

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
        // Dead-credential mid-stream: the server emits 'degraded' then re-streams
        // the FULL lifeboat answer as fresh tokens. Clear the partial-primary
        // buffer here (degraded arrives before the first lifeboat token, so no
        // race) so the lifeboat answer replaces it instead of gluing onto it.
        onDegraded: (d) => patchAssistant({ degraded: d, content: "" }),
        // Keep the row's database id so it stops being identified by position;
        // stash the model so the "— {model}" label matches a reloaded row.
        onDone: (d) =>
          patchAssistant({
            streaming: false,
            id: d.message_id,
            answered_model: d.model,
            prompt_tokens: d.prompt_tokens,
            completion_tokens: d.completion_tokens,
          }),
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
    return (
      <LoginScreen
        onGoogleLogin={handleGoogleLogin}
        onDevLogin={handleLogin}
        devAuth={DEV_AUTH}
        loading={loggingIn}
        error={authError}
      />
    );
  }

  // Only once we KNOW onboarding is incomplete — never while it's still unknown.
  if (onboarded === false) {
    return (
      <OnboardingScreen
        token={token}
        onDone={(name) => {
          setAssistantName(name);
          setOnboarded(true);
        }}
      />
    );
  }

  return (
    <div className="flex h-screen bg-surface font-sans text-on-surface">
      <Sidebar
        view={view}
        setView={setView}
        assistantName={assistantName}
        email={user?.email ?? user?.id ?? ""}
        role={user?.role}
        onLogout={handleLogout}
      />

      {/* Content column — sits to the RIGHT of the nav rail. For chat it holds
          its own [conversation list][thread] pair; everything else is one pane. */}
      <div className="relative flex min-w-0 flex-1 flex-col">
      {/* In-app delivery feed — polls unread, marks read on open. REST, 0 tokens. */}
      <NotificationsBell token={token} onFail={failed} />
      {view === "dashboard" ? (
        <Dashboard token={token} onNavigate={setView} onFail={failed} />
      ) : view === "graph" ? (
        <MemoryGraph token={token} onNavigate={setView} onFail={failed} />
      ) : view === "tasks" ? (
        <Tasks token={token} onFail={failed} />
      ) : view === "reminders" ? (
        <Reminders token={token} onFail={failed} />
      ) : view === "settings" ? (
        <SettingsView
          token={token}
          assistantName={assistantName}
          onSaved={setAssistantName}
          onFail={failed}
          googleReload={googleReload}
          googleNotice={googleNotice}
        />
      ) : view === "admin" ? (
        // UI gate only — fail closed for non-admins. The gateway re-verifies role
        // server-side on every admin mutation, so a crafted view state buys nothing.
        user?.role === "admin" ? (
          <Admin token={token} onFail={failed} />
        ) : (
          <Dashboard token={token} onNavigate={setView} onFail={failed} />
        )
      ) : (
      <div className="flex min-h-0 flex-1">
        {/* Conversation list */}
        <aside className="flex w-64 flex-col border-r border-edge bg-panel">
          <button
            onClick={handleNewConversation}
            className="mx-3 mt-3 rounded-md bg-accent/15 px-3 py-1.5 text-sm font-medium text-accent transition-colors hover:bg-accent/25"
          >
            + New conversation
          </button>

          {/* Select-mode header: a toggle, and while on, a select-all/clear
              control plus the bulk-delete arm. */}
          <div className="flex items-center justify-between px-3 py-2">
            {!selectMode ? (
              <button
                onClick={() => setSelectMode(true)}
                disabled={conversations.length === 0}
                className="text-xs text-muted transition-colors hover:text-on-surface disabled:opacity-40"
              >
                Select
              </button>
            ) : (
              <>
                <label className="flex items-center gap-2 text-xs text-muted">
                  <input
                    type="checkbox"
                    ref={(el) => {
                      // A partial selection reads as indeterminate, not checked.
                      if (el) el.indeterminate = selected.size > 0 && !allSelected;
                    }}
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    aria-label={allSelected ? "Clear selection" : "Select all conversations"}
                    className="accent-accent"
                  />
                  {allSelected ? "Clear" : "Select all"}
                </label>
                <button
                  onClick={exitSelectMode}
                  className="text-xs text-muted transition-colors hover:text-on-surface"
                >
                  Done
                </button>
              </>
            )}
          </div>

          {selectMode && selected.size > 0 && (
            <div className="px-3 pb-2">
              {confirmBulk ? (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => void handleDeleteSelected()}
                    className="rounded px-2 py-1 text-xs font-medium text-error hover:bg-error/10"
                  >
                    Delete {selected.size}?
                  </button>
                  <button
                    onClick={() => setConfirmBulk(false)}
                    className="rounded px-2 py-1 text-xs text-muted hover:bg-raised hover:text-on-surface"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmBulk(true)}
                  className="w-full rounded-md border border-error/40 px-2 py-1 text-xs font-medium text-error transition-colors hover:bg-error/10"
                >
                  Delete selected ({selected.size})
                </button>
              )}
            </div>
          )}

          <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {conversations.length === 0 && !error && (
              <p className="px-2 py-3 text-sm text-faint">
                No conversations yet.
              </p>
            )}
            {conversations.map((c) => {
              const title = c.title?.trim() || "Untitled";
              return (
                <div
                  key={c.id}
                  className={`group relative mb-1 flex items-center rounded-md text-sm transition-colors ${
                    c.id === activeId
                      ? "bg-raised text-on-surface"
                      : "text-muted hover:bg-raised/60 hover:text-on-surface"
                  }`}
                >
                  {selectMode && (
                    <input
                      type="checkbox"
                      checked={selected.has(c.id)}
                      onChange={() => toggleSelected(c.id)}
                      aria-label={title}
                      className="ml-3 shrink-0 accent-accent"
                    />
                  )}
                  <button
                    onClick={() => setActiveId(c.id)}
                    className="min-w-0 flex-1 truncate px-3 py-2 text-left"
                    title={c.title ?? c.id}
                  >
                    {title}
                  </button>
                  {selectMode ? null : confirmDeleteId === c.id ? (
                    <span className="flex shrink-0 items-center gap-1 pr-2">
                      <button
                        onClick={() => void handleDeleteConversation(c.id)}
                        className="rounded px-1.5 py-0.5 text-xs font-medium text-error hover:bg-error/10"
                      >
                        Delete?
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(null)}
                        className="rounded px-1.5 py-0.5 text-xs text-muted hover:bg-raised hover:text-on-surface"
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => setConfirmDeleteId(c.id)}
                      aria-label={"Delete conversation: " + title}
                      className="mr-1 shrink-0 rounded p-1 text-muted opacity-0 transition-opacity hover:text-error focus:opacity-100 group-hover:opacity-100"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6" />
                        <line x1="10" y1="11" x2="10" y2="17" />
                        <line x1="14" y1="11" x2="14" y2="17" />
                      </svg>
                    </button>
                  )}
                </div>
              );
            })}
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
              {/* role:"tool" is never the assistant's own words — agent-svc
                  doesn't emit it, but guard so a stray one is never shown as one. */}
              {messages
                .filter((m) => m.role !== "tool")
                .map((m, i) => (
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
    </div>
  );
}

function LoginScreen({
  onGoogleLogin,
  onDevLogin,
  devAuth,
  loading,
  error,
}: {
  onGoogleLogin: () => void;
  onDevLogin: () => void;
  devAuth: boolean;
  loading: boolean;
  error: string | null;
}) {
  return (
    <div className="flex h-screen flex-col items-center justify-center bg-surface px-4 font-sans text-on-surface">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-xl border border-edge bg-panel px-8 py-10 text-center">
        <h1 className="font-display text-3xl font-semibold tracking-wide text-accent">
          Raphael
        </h1>
        <p className="text-sm text-muted">Sign in to continue.</p>

        {/* Primary door: Google Sign-In is the login and the sign-up. An invited
            email becomes a member; the very first sign-in ever bootstraps the admin;
            an uninvited email is rejected at the callback (?login=denied). */}
        <button
          onClick={onGoogleLogin}
          disabled={loading}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-md border border-edge bg-raised px-5 py-2.5 text-sm font-medium text-on-surface transition-colors hover:bg-panel disabled:opacity-40"
        >
          <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
          </svg>
          {loading ? "Signing in…" : "Sign in with Google"}
        </button>

        {/* Dev backdoor, compiled in only when NEXT_PUBLIC_DEV_AUTH=1. */}
        {devAuth && (
          <div className="w-full border-t border-edge pt-4">
            <p className="mb-2 text-[11px] uppercase tracking-widest text-faint">
              Dev mode — sign in as {DEV_EMAIL}
            </p>
            <button
              onClick={onDevLogin}
              disabled={loading}
              className="w-full rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong disabled:opacity-40"
            >
              {loading ? "Signing in…" : "Dev login"}
            </button>
          </div>
        )}

        {error && (
          <p className="max-w-md text-center text-sm text-error">{error}</p>
        )}
      </div>
    </div>
  );
}

// First-login screen: pick the assistant's name, then mark onboarding complete.
// Same flat card as LoginScreen. A blank name falls back to "Raphael" — the goal
// is to get the user in, not to block them on a field.
function OnboardingScreen({
  token,
  onDone,
}: {
  token: string;
  onDone: (name: string) => void;
}) {
  const [name, setName] = useState("Raphael");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const p = await updateProfile(token, name.trim() || "Raphael", { onboarded: true });
      onDone(p.assistant_name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false); // stay put so they can retry — don't advance on failure
    }
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-surface px-4 font-sans text-on-surface">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-edge bg-panel px-8 py-10">
        <div className="text-center">
          <h1 className="font-display text-3xl font-semibold tracking-wide text-accent">
            Welcome
          </h1>
          <p className="mt-2 text-sm text-muted">
            What would you like to call your assistant?
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

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-[11px] uppercase tracking-widest text-faint">
            Assistant name
          </span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
            maxLength={40}
            placeholder="Raphael"
            className="rounded-md border border-edge bg-raised px-2 py-1.5 text-on-surface placeholder:text-faint outline-none transition-colors focus:border-accent"
          />
        </label>

        <button
          onClick={() => void submit()}
          disabled={saving}
          className="w-full rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong disabled:opacity-40"
        >
          {saving ? "Saving…" : "Continue"}
        </button>
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
  onFail,
  googleReload,
  googleNotice,
}: {
  token: string;
  assistantName: string;
  onSaved: (name: string) => void;
  onFail: (e: unknown) => void;
  googleReload: number;
  googleNotice: { ok: boolean; msg: string } | null;
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

        <TimezoneForm token={token} onFail={onFail} />

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

        <GoogleSection
          token={token}
          onFail={onFail}
          reload={googleReload}
          notice={googleNotice}
        />
      </div>
    </div>
  );
}

// Read-only Google connector: link/unlink the user's Calendar + profile. The
// gateway owns the OAuth dance; this only kicks it off and reflects status.
function GoogleSection({
  token,
  onFail,
  reload,
  notice,
}: {
  token: string;
  onFail: (e: unknown) => void;
  reload: number;
  notice: { ok: boolean; msg: string } | null;
}) {
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

// The notifications bell: polls the unread feed for a badge, and on open marks
// that batch read (one PATCH per id) and shows it. Poll-based delivery, reusing
// the REST proxy — no SSE, no tokens. Firing writes the notification row (the sink).
function NotificationsBell({
  token,
  onFail,
}: {
  token: string;
  onFail: (e: unknown) => void;
}) {
  const [unread, setUnread] = useState<Notification[]>([]);
  const [viewing, setViewing] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);

  const poll = useCallback(async () => {
    try {
      setUnread(await getNotifications(token, { unread: true }));
    } catch (e) {
      onFail(e);
    }
  }, [token, onFail]);

  // Poll on mount, then every ~45s. Cleared on unmount / token change.
  useEffect(() => {
    void poll();
    const t = setInterval(() => void poll(), 45000);
    return () => clearInterval(t);
  }, [poll]);

  // Opening snapshots the current unread batch, clears the badge optimistically,
  // and marks each read server-side; the next poll confirms. Closing just hides.
  function toggle() {
    if (!open) {
      setViewing(unread);
      if (unread.length > 0) {
        const ids = unread.map((n) => n.id);
        setUnread([]);
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

// Timezone picker: reminders fire in this IANA tz (evaluated server-side). The
// browser tz is auto-stamped on app-load; this row lets the user view/override.
// A native <select> from Intl.supportedValuesOf — no timezone dependency.
function TimezoneForm({
  token,
  onFail,
}: {
  token: string;
  onFail: (e: unknown) => void;
}) {
  const detected = detectedTz();
  const [tz, setTz] = useState(detected);
  const [saved, setSaved] = useState(detected);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);

  // localStorage is client-only; hydrate the last-sent value in an effect. This
  // is the picker's source of truth since the server exposes no tz getter.
  useEffect(() => {
    const v = localStorage.getItem(TZ_VALUE) ?? detected;
    setTz(v);
    setSaved(v);
  }, [detected]);

  const zones = useMemo<string[]>(() => {
    // Native IANA list (ladder: platform feature over a tz library). Not yet in
    // every TS lib target, so probe it; fall back to just the current value.
    const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
      .supportedValuesOf;
    const list = typeof f === "function" ? f("timeZone") : [];
    return list.includes(tz) ? list : [tz, ...list];
  }, [tz]);

  async function save() {
    if (busy || tz === saved) return;
    setBusy(true);
    setOk(false);
    try {
      await setTimezone(token, tz);
      localStorage.setItem(TZ_VALUE, tz);
      // Mark this browser reconciled so app-load auto-detect won't overwrite the
      // manual choice on the next load.
      localStorage.setItem(TZ_SEEN, detected);
      setSaved(tz);
      setOk(true);
    } catch (e) {
      onFail(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-edge bg-panel p-4">
      <h3 className="mb-1 text-base font-semibold text-on-surface">Timezone</h3>
      <p className="mb-4 text-sm text-muted">
        Reminders fire in this timezone. Detected from your browser as{" "}
        <span className="font-medium text-on-surface">{detected}</span>.
      </p>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-[11px] uppercase tracking-widest text-faint">
          IANA timezone
        </span>
        <select
          value={tz}
          onChange={(e) => {
            setTz(e.target.value);
            setOk(false);
          }}
          className="rounded-md border border-edge bg-raised px-2 py-1.5 text-on-surface outline-none transition-colors focus:border-accent"
        >
          {zones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
      </label>

      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={() => void save()}
          disabled={busy || tz === saved}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {ok && tz === saved && (
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

        {/* Tools the assistant used this turn — data round-trips from the DB. */}
        {!isUser && message.tool_calls?.length ? (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {message.tool_calls.map((tc, i) => {
              const q = typeof tc.arguments?.query === "string" ? tc.arguments.query : "";
              return (
                <span
                  key={i}
                  className="inline-flex items-center rounded-md bg-raised px-2 py-0.5 text-xs text-muted"
                >
                  🔍 {tc.name}
                  {q ? `: ${q.length > 40 ? q.slice(0, 40) + "…" : q}` : ""}
                </span>
              );
            })}
          </div>
        ) : null}

        <div className="mt-1 whitespace-pre-wrap text-sm text-on-surface">
          {message.content}
          {message.streaming && !message.content && (
            <span className="text-muted">…</span>
          )}
        </div>

        {/* Which model answered — live via onDone, reloaded via answered_model. */}
        {!isUser && message.answered_model && (
          <div className="mt-1 text-xs text-muted">— {message.answered_model}</div>
        )}

        {/* Per-turn token cost — the visible "less AI" signal. Only when the
            server reported a number; unknown shows nothing, never a fake 0. */}
        {!isUser &&
          (typeof message.prompt_tokens === "number" ||
            typeof message.completion_tokens === "number") && (
            <div className="mt-0.5 text-xs text-faint">
              ·{" "}
              {typeof message.prompt_tokens === "number"
                ? `${message.prompt_tokens.toLocaleString()} in`
                : ""}
              {typeof message.prompt_tokens === "number" &&
              typeof message.completion_tokens === "number"
                ? " / "
                : ""}
              {typeof message.completion_tokens === "number"
                ? `${message.completion_tokens.toLocaleString()} out`
                : ""}
            </div>
          )}

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
