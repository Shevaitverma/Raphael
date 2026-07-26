"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import MessageRow from "./MessageRow";
import type { UiMessage } from "../shared";
import {
  createConversation,
  deleteConversation,
  listConversations,
  listMessages,
  storedDegraded,
  streamChat,
  type Conversation,
} from "@/lib/gateway";
import { useAuthed } from "../auth/AuthProvider";

// The whole chat concern: conversation list, thread, composer, and the SSE
// stream. The shell owns auth, the nav and the error banner state — chat reads
// `error` to decide its empty states and pushes failures back through onFail.
export default function ChatView({
  assistantName,
  searchOn,
  searchAvailable,
  onToggleSearch,
  error,
  onClearError,
}: {
  assistantName: string;
  searchOn: boolean;
  searchAvailable: boolean;
  onToggleSearch: (on: boolean) => void;
  error: string | null;
  // Must be referentially stable (useCallback in the shell): it lives in the
  // dep list of the callbacks that drive the list/load effects below.
  onClearError: () => void;
}) {
  // `failed` is a useCallback in AuthProvider — stable identity, same as when it
  // arrived as the onFail prop, so the dep lists below still don't re-fire.
  const { token, failed: onFail } = useAuthed();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const threadRef = useRef<HTMLDivElement>(null);
  // The in-flight chat stream, so switching conversations, signing out, or
  // pressing Stop can cut it loose. The gateway never times a stream out.
  const abortRef = useRef<AbortController | null>(null);
  // A conversation we just created: the load effect must skip it exactly once.
  const skipLoadRef = useRef<string | null>(null);
  // Mirror of activeId for refreshConversations' initial-select guard, so the
  // callback can read the current selection without listing activeId as a dep
  // (which would re-fire the list GET on every conversation switch).
  const activeIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  // Signing out unmounts this component (token goes null -> login screen), and
  // so does leaving the chat tab. Either way an in-flight stream must be cut
  // loose here: the state it streams into is gone with us.
  useEffect(() => () => abortRef.current?.abort(), []);

  // --- conversations ---------------------------------------------------------

  const refreshConversations = useCallback(async () => {
    try {
      const convs = await listConversations(token);
      setConversations(convs);
      onClearError();
      if (convs.length > 0 && activeIdRef.current === null) {
        setActiveId(convs[0].id);
      }
    } catch (e) {
      onFail(e);
    }
  }, [token, onClearError, onFail]);

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  const loadMessages = useCallback(
    async (conversationId: string) => {
      try {
        const msgs = await listMessages(token, conversationId);
        // Rebuild the live Degraded shape from stored provenance so a reloaded
        // lifeboat answer renders the SAME banner it did while streaming.
        setMessages(msgs.map((m) => ({ ...m, degraded: storedDegraded(m) })));
        onClearError();
      } catch (e) {
        // Clear rather than leave the previous conversation's messages under
        // this one's header. The banner below says why the thread is empty —
        // silently blanking it is what made a dead backend look like no data.
        setMessages([]);
        onFail(e);
      }
    },
    [token, onClearError, onFail],
  );

  useEffect(() => {
    if (!activeId) return;
    // Registered on every viewed conversation — including a just-created one —
    // so navigating AWAY aborts its in-flight stream. This does not abort the
    // stream handleSend is about to start: cleanup only fires on the NEXT
    // activeId change or unmount, never on this run.
    const cleanup = () => abortRef.current?.abort();
    // A conversation we just created holds only the optimistic messages already
    // on screen. Loading it would replace them mid-stream and drop the reply.
    if (skipLoadRef.current === activeId) {
      skipLoadRef.current = null;
      return cleanup;
    }
    void loadMessages(activeId);
    return cleanup;
  }, [activeId, loadMessages]);

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
  // one 404/500 is recorded and the rest still run, then surfaced via onFail().
  async function handleDeleteSelected() {
    if (selected.size === 0) return;
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
    if (lastError) onFail(lastError);
    else {
      onClearError();
      void refreshConversations();
    }
  }

  async function handleDeleteConversation(id: string) {
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
      onClearError();
    } catch (e) {
      onFail(e);
    }
  }

  async function handleNewConversation() {
    try {
      const conv = await createConversation(token);
      setConversations((prev) => [conv, ...prev]);
      skipLoadRef.current = conv.id;
      setActiveId(conv.id);
      setMessages([]);
      onClearError();
    } catch (e) {
      onFail(e);
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
    if (!text || sending) return;

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
        onFail(e);
        return;
      }
    }

    setDraft("");
    onClearError();
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

  return (
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
                <MessageRow key={m.localId ?? m.id ?? i} message={m} assistantName={assistantName} />
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
              onChange={(e) => onToggleSearch(e.target.checked)}
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
  );
}
