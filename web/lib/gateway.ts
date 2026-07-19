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
  // Answer provenance, stored server-side so a reload renders the same banner
  // and model label the live SSE stream did (see Degraded/Done below).
  answered_model?: string | null;
  degraded?: boolean;
  tool_calls?: { name: string; arguments: Record<string, unknown> }[];
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

// A reloaded message stores provenance as `degraded` (boolean) + `answered_model`,
// while the live SSE stream carries a full Degraded object. Rebuild that same shape
// from stored state so a reload renders the identical warning banner — a lifeboat
// answer must never look like a normal one just because the page was refreshed.
export function storedDegraded(m: Message): Degraded | undefined {
  return m.degraded
    ? { reason: "", provider: "local", model: m.answered_model ?? "" }
    : undefined;
}

// --- errors ------------------------------------------------------------------

// A failed API call, carrying the HTTP status so callers can tell an expired
// session apart from a service that is merely down.
export class ApiError extends Error {
  // A plain field, not a constructor parameter property: node's strip-only
  // type stripping (how `npm test` runs) rejects those.
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// A 401 on /api/* means the JWT expired (it is minted with a 24h TTL) — the
// session is over and nothing but a fresh login will fix it.
export function isAuthError(e: unknown): boolean {
  return e instanceof ApiError && e.status === 401;
}

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
    throw new ApiError(`list conversations failed: ${res.status}`, res.status);
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
    throw new ApiError(`create conversation failed: ${res.status}`, res.status);
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
    throw new ApiError(`list messages failed: ${res.status}`, res.status);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : (data.messages ?? []);
}

// --- provider credentials ----------------------------------------------------

export type Credential = {
  id: string;
  provider: "anthropic" | "openai_compat" | "local";
  auth_type: "api_key" | "oauth";
  base_url?: string | null;
  model_id: string;
  is_active: boolean;
  is_lifeboat: boolean;
  created_at?: string;
};

export type NewCredential = {
  provider: string;
  auth_type: string;
  api_key?: string;
  base_url?: string | null;
  model_id: string;
  activate: boolean;
};

export async function listProviders(token: string): Promise<Credential[]> {
  const res = await fetch(`${GATEWAY_URL}/api/providers`, { headers: authHeader(token) });
  if (!res.ok) throw new ApiError(`list providers failed: ${res.status}`, res.status);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.credentials ?? []);
}

export async function addProvider(token: string, cred: NewCredential): Promise<Credential> {
  const res = await fetch(`${GATEWAY_URL}/api/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader(token) },
    body: JSON.stringify(cred),
  });
  if (!res.ok) throw new ApiError(await errText(res, "add provider"), res.status);
  return res.json();
}

export async function activateProvider(token: string, id: string): Promise<Credential> {
  const res = await fetch(`${GATEWAY_URL}/api/providers/${id}/activate`, {
    method: "POST",
    headers: authHeader(token),
  });
  if (!res.ok) throw new ApiError(await errText(res, "activate"), res.status);
  return res.json();
}

export async function setLifeboat(token: string, id: string): Promise<Credential> {
  const res = await fetch(`${GATEWAY_URL}/api/providers/${id}/lifeboat`, {
    method: "POST",
    headers: authHeader(token),
  });
  if (!res.ok) throw new ApiError(await errText(res, "set lifeboat"), res.status);
  return res.json();
}

export async function clearLifeboat(token: string, id: string): Promise<Credential> {
  const res = await fetch(`${GATEWAY_URL}/api/providers/${id}/lifeboat`, {
    method: "DELETE",
    headers: authHeader(token),
  });
  if (!res.ok) throw new ApiError(await errText(res, "clear lifeboat"), res.status);
  return res.json();
}

// --- profile (display-only assistant name) -----------------------------------

export type Profile = { assistant_name: string; onboarded: boolean };

export async function getProfile(token: string): Promise<Profile> {
  const res = await fetch(`${GATEWAY_URL}/api/profile`, { headers: authHeader(token) });
  if (!res.ok) throw new ApiError(`get profile failed: ${res.status}`, res.status);
  return res.json();
}

// `onboarded` is sent only when opts.onboarded is given, so Settings (which omits
// it) leaves the server flag untouched while onboarding can set it true.
export async function updateProfile(
  token: string,
  assistantName: string,
  opts?: { onboarded?: boolean },
): Promise<Profile> {
  const body: { assistant_name: string; onboarded?: boolean } = {
    assistant_name: assistantName,
  };
  if (opts?.onboarded !== undefined) body.onboarded = opts.onboarded;
  const res = await fetch(`${GATEWAY_URL}/api/profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeader(token) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(await errText(res, "save name"), res.status);
  return res.json();
}

// --- capabilities ------------------------------------------------------------

export type Capabilities = {
  provider: string;
  model: string;
  max_context_tokens?: number;
  // How the gateway knows the model/context window: "discovered" (asked the
  // provider), "static" (from a lookup table), or "default" (a fallback guess).
  source?: string;
  web_search: boolean;
  google_connected?: boolean;
};

export async function getCapabilities(token: string): Promise<Capabilities> {
  const res = await fetch(`${GATEWAY_URL}/api/capabilities`, { headers: authHeader(token) });
  if (!res.ok) throw new ApiError(`capabilities failed: ${res.status}`, res.status);
  return res.json();
}

// --- memory: knowledge graph + stats -----------------------------------------
// Both routes are read-only projections of what Raphael has learned. Same
// fetch/ApiError/authHeader shape as getCapabilities.

export type GraphNode = {
  id: string;
  label: string;
  kind: "identity" | "entity";
  degree: number;
};

export type GraphEdge = {
  source: string;
  target: string;
  label: string;
  confidence: number;
  times_seen: number;
  first_seen?: string;
  last_seen?: string;
};

export type GraphNote = {
  id: string;
  content: string;
  confidence: number;
  last_seen?: string;
};

export type GraphData = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  notes: GraphNote[];
  truncated: boolean;
};

export type TopFact = {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  times_seen: number;
  last_seen?: string;
};

export type MemoryStats = {
  facts: number;
  episodic: number;
  conversations: number;
  top_facts: TopFact[];
  activity: { day: string; count: number }[];
  truncated: boolean;
};

export async function getMemoryGraph(token: string): Promise<GraphData> {
  const res = await fetch(`${GATEWAY_URL}/api/memory/graph`, { headers: authHeader(token) });
  if (!res.ok) throw new ApiError(`memory graph failed: ${res.status}`, res.status);
  const d = await res.json();
  return {
    nodes: Array.isArray(d.nodes) ? d.nodes : [],
    edges: Array.isArray(d.edges) ? d.edges : [],
    notes: Array.isArray(d.notes) ? d.notes : [],
    truncated: !!d.truncated,
  };
}

export async function getMemoryStats(token: string): Promise<MemoryStats> {
  const res = await fetch(`${GATEWAY_URL}/api/memory/stats`, { headers: authHeader(token) });
  if (!res.ok) throw new ApiError(`memory stats failed: ${res.status}`, res.status);
  const d = await res.json();
  return {
    facts: d.facts ?? 0,
    episodic: d.episodic ?? 0,
    conversations: d.conversations ?? 0,
    top_facts: Array.isArray(d.top_facts) ? d.top_facts : [],
    activity: Array.isArray(d.activity) ? d.activity : [],
    truncated: !!d.truncated,
  };
}

// --- Google connector (read-only Calendar + profile) -------------------------

export type GoogleStatus = {
  connected: boolean;
  email: string | null;
  scopes: string[];
};

// Returns the Google consent URL to navigate to. A 503 means this deployment has
// no Google credentials configured — the ApiError carries the 503 so the UI can
// show the inert "not configured" note instead of a broken button.
export async function connectGoogle(token: string): Promise<{ auth_url: string }> {
  const res = await fetch(`${GATEWAY_URL}/api/google/connect`, { headers: authHeader(token) });
  if (!res.ok) throw new ApiError(await errText(res, "connect Google"), res.status);
  return res.json();
}

export async function googleStatus(token: string): Promise<GoogleStatus> {
  const res = await fetch(`${GATEWAY_URL}/api/google/status`, { headers: authHeader(token) });
  if (!res.ok) throw new ApiError(`google status failed: ${res.status}`, res.status);
  const data = await res.json();
  return {
    connected: !!data.connected,
    email: data.email ?? null,
    scopes: Array.isArray(data.scopes) ? data.scopes : [],
  };
}

export async function disconnectGoogle(token: string): Promise<void> {
  const res = await fetch(`${GATEWAY_URL}/api/google`, {
    method: "DELETE",
    headers: authHeader(token),
  });
  if (!res.ok) throw new ApiError(await errText(res, "disconnect Google"), res.status);
}

// Pull a human-readable message out of the {"error": "..."} body.
async function errText(res: Response, action: string): Promise<string> {
  const body = await safeText(res);
  try {
    const j = JSON.parse(body);
    if (j?.error) return `${action}: ${j.error}`;
  } catch {
    /* fall through */
  }
  return `${action} failed: ${res.status}`;
}

// A chat request that never became a stream. agent-svc answers 409 when the user
// has no active credential and the gateway copies status and body straight
// through, so name the one fix that exists rather than echoing an upstream body.
async function chatErrorMessage(res: Response): Promise<string> {
  if (res.status === 409) {
    return "No model provider is active. Add one in Settings, then send this message again.";
  }
  return errText(res, "chat");
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
  body: { conversation_id: string; message: string; search?: boolean },
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
    // Aborting before the first byte (Stop on a stream that never opened) is
    // the user's own doing, not a network failure.
    if ((e as Error)?.name === "AbortError") return;
    handlers.onError(networkMessage(e));
    return;
  }

  if (!res.ok || !res.body) {
    handlers.onError(await chatErrorMessage(res));
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
