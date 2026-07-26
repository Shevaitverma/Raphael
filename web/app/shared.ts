// Module-scope constants, helpers and types shared by page.tsx and the leaf
// components extracted out of it. Anything used by exactly one component lives
// with that component instead.

import type { Degraded, Message } from "@/lib/gateway";

// Persisted timezone reconciliation (client-side; the server has no tz getter).
// TZ_SEEN = the browser tz we last auto-stamped, so app-load auto-detect fires
// only when the browser's own tz actually changes (never clobbering a manual
// Settings choice). TZ_VALUE = the last tz we sent, for the Settings picker.
export const TZ_SEEN = "raphael.tz.seen";
export const TZ_VALUE = "raphael.tz.value";

export function detectedTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export const DEV_EMAIL = "dev@raphael.local";

// UI message carries extra render state that never touches the database. It
// overrides Message.degraded (a stored boolean) with the live Degraded object
// the banner renders — loadMessages rebuilds that object from stored state so
// live and reloaded rows are indistinguishable.
export type UiMessage = Omit<Message, "degraded"> & {
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
