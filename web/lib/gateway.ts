// Thin client for the Raphael gateway. No secrets live here — the JWT is passed
// in from component state (held in memory), never read from localStorage.

const GATEWAY_URL =
  process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8080";

export type User = {
  id: string;
  email?: string;
  name?: string;
};

export type DevLoginResponse = {
  token: string;
  user: User;
};

export type Conversation = {
  id: string;
  user_id?: string;
  title?: string;
  created_at?: string;
};

export type Message = {
  id?: string;
  conversation_id?: string;
  role: "user" | "assistant" | "tool";
  content: string;
  created_at?: string;
};

// --- Degraded / error metadata surfaced from the SSE stream ------------------

export type Degraded = {
  reason: string;
  provider: string;
  model: string;
};

export type Done = {
  provider?: string;
  model?: string;
  message_id?: string;
};

// --- REST calls --------------------------------------------------------------

export async function devLogin(email: string): Promise<DevLoginResponse> {
  const res = await fetch(`${GATEWAY_URL}/auth/dev-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    throw new Error(`dev-login failed: ${res.status} ${await safeText(res)}`);
  }
  return res.json();
}

export async function listConversations(token: string): Promise<Conversation[]> {
  const res = await fetch(`${GATEWAY_URL}/api/conversations`, {
    headers: authHeader(token),
  });
  if (!res.ok) {
    throw new Error(`list conversations failed: ${res.status}`);
  }
  const data = await res.json();
  // Gateway may return a bare array or {conversations:[...]}.
  return Array.isArray(data) ? data : (data.conversations ?? []);
}

export async function createConversation(
  token: string,
  title?: string,
): Promise<Conversation> {
  const res = await fetch(`${GATEWAY_URL}/api/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader(token) },
    body: JSON.stringify({ title: title ?? "New conversation" }),
  });
  if (!res.ok) {
    throw new Error(`create conversation failed: ${res.status}`);
  }
  return res.json();
}

export async function listMessages(
  token: string,
  conversationId: string,
): Promise<Message[]> {
  const res = await fetch(
    `${GATEWAY_URL}/api/conversations/${conversationId}/messages`,
    { headers: authHeader(token) },
  );
  if (!res.ok) {
    throw new Error(`list messages failed: ${res.status}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : (data.messages ?? []);
}

// --- SSE chat ----------------------------------------------------------------

export type ChatHandlers = {
  onToken: (text: string) => void;
  onDegraded: (d: Degraded) => void;
  onDone: (d: Done) => void;
  onError: (message: string) => void;
};

// Streams POST /api/chat. We use fetch + ReadableStream (not EventSource) so we
// can send the Authorization header. Parses the text/event-stream framing by
// hand: events are separated by a blank line, fields are "event:" and "data:".
export async function streamChat(
  token: string,
  body: { conversation_id: string; message: string },
  handlers: ChatHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${GATEWAY_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...authHeader(token),
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    handlers.onError(networkMessage(e));
    return;
  }

  if (!res.ok || !res.body) {
    handlers.onError(`chat request failed: ${res.status} ${await safeText(res)}`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // An SSE event is terminated by a blank line. Handle both \n\n and \r\n\r\n.
      let sep: number;
      while ((sep = indexOfBlankLine(buffer)) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + blankLineLength(buffer, sep));
        dispatchEvent(rawEvent, handlers);
      }
    }
    // Flush any trailing event without a terminating blank line.
    if (buffer.trim().length > 0) {
      dispatchEvent(buffer, handlers);
    }
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return;
    handlers.onError(networkMessage(e));
  } finally {
    reader.releaseLock();
  }
}

function dispatchEvent(raw: string, handlers: ChatHandlers): void {
  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(":")) continue; // comment / heartbeat
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    }
  }

  const dataStr = dataLines.join("\n");
  if (dataStr.length === 0) return;

  let data: unknown;
  try {
    data = JSON.parse(dataStr);
  } catch {
    // Non-JSON payload: only meaningful for token text.
    if (eventName === "token") handlers.onToken(dataStr);
    return;
  }

  const obj = data as Record<string, unknown>;
  switch (eventName) {
    case "token":
      handlers.onToken(String(obj.text ?? ""));
      break;
    case "degraded":
      handlers.onDegraded({
        reason: String(obj.reason ?? "credential rejected"),
        provider: String(obj.provider ?? "local"),
        model: String(obj.model ?? ""),
      });
      break;
    case "done":
      handlers.onDone({
        provider: obj.provider ? String(obj.provider) : undefined,
        model: obj.model ? String(obj.model) : undefined,
        message_id: obj.message_id ? String(obj.message_id) : undefined,
      });
      break;
    case "error":
      handlers.onError(String(obj.message ?? "unknown error"));
      break;
    default:
      break;
  }
}

// --- helpers -----------------------------------------------------------------

function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

function networkMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return `Could not reach the gateway. ${msg}`;
}

// Returns the index of the first blank-line separator, or -1.
function indexOfBlankLine(s: string): number {
  const a = s.indexOf("\n\n");
  const b = s.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function blankLineLength(s: string, at: number): number {
  return s.startsWith("\r\n\r\n", at) ? 4 : 2;
}
