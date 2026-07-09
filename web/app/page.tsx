"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createConversation,
  devLogin,
  listConversations,
  listMessages,
  streamChat,
  type Conversation,
  type Degraded,
  type Message,
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
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <h1 className="text-lg font-semibold">Raphael</h1>
        <div className="flex items-center gap-3 text-sm text-neutral-500">
          <span>{user?.email ?? user?.id}</span>
          <button
            onClick={handleLogout}
            className="rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Conversation list */}
        <aside className="flex w-64 flex-col border-r border-neutral-200 dark:border-neutral-800">
          <button
            onClick={handleNewConversation}
            className="m-3 rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            + New conversation
          </button>
          <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {conversations.length === 0 && (
              <p className="px-2 py-3 text-sm text-neutral-400">
                No conversations yet.
              </p>
            )}
            {conversations.map((c) => (
              <button
                key={c.id}
                onClick={() => setActiveId(c.id)}
                className={`mb-1 block w-full truncate rounded-md px-3 py-2 text-left text-sm ${
                  c.id === activeId
                    ? "bg-neutral-200 dark:bg-neutral-800"
                    : "hover:bg-neutral-100 dark:hover:bg-neutral-900"
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
            <div className="mx-auto flex max-w-3xl flex-col gap-4">
              {messages.length === 0 && (
                <p className="py-16 text-center text-sm text-neutral-400">
                  Send a message to start.
                </p>
              )}
              {messages.map((m, i) => (
                <MessageBubble key={m.id ?? i} message={m} />
              ))}
            </div>
          </div>

          <div className="border-t border-neutral-200 px-4 py-3 dark:border-neutral-800">
            <div className="mx-auto flex max-w-3xl items-end gap-2">
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
                className="max-h-40 min-h-[44px] flex-1 resize-none rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900"
              />
              <button
                onClick={() => void handleSend()}
                disabled={sending || draft.trim().length === 0}
                className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
              >
                {sending ? "…" : "Send"}
              </button>
            </div>
          </div>
        </main>
      </div>
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
    <div className="flex h-screen flex-col items-center justify-center gap-4 px-4">
      <h1 className="text-2xl font-semibold">Raphael</h1>
      <p className="text-sm text-neutral-500">Dev mode — sign in as {DEV_EMAIL}</p>
      <button
        onClick={onLogin}
        disabled={loading}
        className="rounded-lg bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
      >
        {loading ? "Signing in…" : "Dev login"}
      </button>
      {error && (
        <p className="max-w-md text-center text-sm text-red-600">{error}</p>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: UiMessage }) {
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] ${isUser ? "items-end" : "items-start"}`}>
        <div
          className={`whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm ${
            isUser
              ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
              : "bg-neutral-200 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
          }`}
        >
          {message.content}
          {message.streaming && !message.content && (
            <span className="text-neutral-400">…</span>
          )}
        </div>

        {/* Degraded banner — the lifeboat fired. Product requirement. */}
        {message.degraded && (
          <div className="mt-1.5 rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-600/60 dark:bg-amber-950/40 dark:text-amber-300">
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
          <div className="mt-1.5 rounded-md border border-red-400 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-600/60 dark:bg-red-950/40 dark:text-red-300">
            {message.error}
          </div>
        )}
      </div>
    </div>
  );
}
