"use client";

import type { UiMessage } from "../shared";

export default function MessageRow({
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
            Answered by {message.degraded.provider}{" "}
            <span className="font-semibold">
              {message.degraded.model || message.degraded.provider}
            </span>{" "}
            — the active provider&apos;s credential was rejected
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
