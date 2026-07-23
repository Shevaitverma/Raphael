import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addAllowedEmail,
  ApiError,
  connectGoogle,
  createTask,
  deleteConversation,
  deleteTask,
  disconnectGoogle,
  fetchSession,
  getCapabilities,
  getMemoryGraph,
  getMemoryStats,
  getProfile,
  getTasks,
  googleLogin,
  googleStatus,
  listAllowedEmails,
  listMessages,
  listProviders,
  listUsers,
  removeAllowedEmail,
  setUserRole,
  storedDegraded,
  streamChat,
  updateProfile,
  updateTask,
  type ChatHandlers,
  type Degraded,
  type Done,
} from "../lib/gateway.ts";

// Build a Response whose body streams the given string in the given chunk sizes,
// so we exercise the parser's handling of events split across network reads.
function sseResponse(payload: string, chunkSize: number): Response {
  const bytes = new TextEncoder().encode(payload);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

type Collected = {
  tokens: string[];
  degraded: Degraded[];
  done: Done[];
  errors: string[];
};

function collect(): Collected {
  return { tokens: [], degraded: [], done: [], errors: [] };
}

function handlers(c: Collected): ChatHandlers {
  return {
    onToken: (t) => c.tokens.push(t),
    onDegraded: (d) => c.degraded.push(d),
    onDone: (d) => c.done.push(d),
    onError: (m) => c.errors.push(m),
  };
}

async function run(payload: string, chunkSize: number): Promise<Collected> {
  const c = collect();
  const orig = globalThis.fetch;
  globalThis.fetch = async () => sseResponse(payload, chunkSize);
  try {
    await streamChat(
      "fake-token",
      { conversation_id: "c1", message: "hi" },
      handlers(c),
    );
  } finally {
    globalThis.fetch = orig;
  }
  return c;
}

const HAPPY = [
  "event: token\ndata: {\"text\":\"He\"}\n\n",
  "event: token\ndata: {\"text\":\"llo\"}\n\n",
  "event: done\ndata: {\"provider\":\"local\",\"model\":\"qwen2.5:7b\",\"message_id\":\"m1\"}\n\n",
].join("");

test("parses token stream and done event", async () => {
  const c = await run(HAPPY, 4096);
  assert.deepEqual(c.tokens, ["He", "llo"]);
  assert.equal(c.tokens.join(""), "Hello");
  assert.equal(c.done.length, 1);
  assert.equal(c.done[0].model, "qwen2.5:7b");
  assert.equal(c.done[0].message_id, "m1");
  assert.equal(c.errors.length, 0);
});

test("done event carries prompt/completion tokens when present", async () => {
  const payload =
    "event: done\ndata: {\"model\":\"qwen2.5:7b\",\"prompt_tokens\":1234,\"completion_tokens\":567}\n\n";
  const c = await run(payload, 4096);
  assert.equal(c.done.length, 1);
  assert.equal(c.done[0].prompt_tokens, 1234);
  assert.equal(c.done[0].completion_tokens, 567);
});

test("done event leaves token counts undefined when absent or null", async () => {
  const payload =
    "event: done\ndata: {\"model\":\"qwen2.5:7b\",\"prompt_tokens\":null}\n\n";
  const c = await run(payload, 4096);
  assert.equal(c.done.length, 1);
  // null (unknown) and absent both become undefined — never a fabricated 0.
  assert.equal(c.done[0].prompt_tokens, undefined);
  assert.equal(c.done[0].completion_tokens, undefined);
});

test("reassembles events split across arbitrary chunk boundaries", async () => {
  // One byte at a time is the worst case for the framing logic.
  const c = await run(HAPPY, 1);
  assert.equal(c.tokens.join(""), "Hello");
  assert.equal(c.done.length, 1);
});

test("surfaces the degraded event (lifeboat banner)", async () => {
  const payload =
    "event: token\ndata: {\"text\":\"Hi\"}\n\n" +
    "event: degraded\ndata: {\"reason\":\"credential rejected\",\"provider\":\"local\",\"model\":\"qwen2.5:7b\"}\n\n" +
    "event: done\ndata: {\"provider\":\"local\",\"model\":\"qwen2.5:7b\"}\n\n";
  const c = await run(payload, 7);
  assert.equal(c.degraded.length, 1);
  assert.equal(c.degraded[0].model, "qwen2.5:7b");
  assert.equal(c.degraded[0].reason, "credential rejected");
  assert.equal(c.tokens.join(""), "Hi");
});

test("surfaces the error event", async () => {
  const payload = "event: error\ndata: {\"message\":\"boom\"}\n\n";
  const c = await run(payload, 4096);
  assert.deepEqual(c.errors, ["boom"]);
});

test("handles CRLF framing and heartbeat comments", async () => {
  const payload =
    ": keep-alive\r\n\r\n" +
    "event: token\r\ndata: {\"text\":\"X\"}\r\n\r\n" +
    "event: done\r\ndata: {}\r\n\r\n";
  const c = await run(payload, 5);
  assert.equal(c.tokens.join(""), "X");
  assert.equal(c.done.length, 1);
});

test("flushes a trailing event with no terminating blank line", async () => {
  const payload = "event: token\ndata: {\"text\":\"tail\"}";
  const c = await run(payload, 4096);
  assert.equal(c.tokens.join(""), "tail");
});

test("reports an error when the gateway is unreachable", async () => {
  const c = collect();
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  try {
    await streamChat("t", { conversation_id: "c1", message: "hi" }, handlers(c));
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(c.errors.length, 1);
  assert.match(c.errors[0], /gateway/i);
});

// --- the no-credential 409 ---------------------------------------------------

test("a 409 names the fix instead of dumping the upstream body", async () => {
  const c = collect();
  const orig = globalThis.fetch;
  // agent-svc's FastAPI body, copied through verbatim by the gateway proxy.
  globalThis.fetch = async () =>
    new Response('{"detail":"no active credential; add a provider key"}', {
      status: 409,
    });
  try {
    await streamChat("t", { conversation_id: "c1", message: "hi" }, handlers(c));
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(c.errors.length, 1);
  assert.match(c.errors[0], /Settings/);
  // No raw JSON, no status code soup.
  assert.doesNotMatch(c.errors[0], /[{}]|detail|409/);
});

test("a non-409 chat failure still reports, without the raw body", async () => {
  const c = collect();
  const orig = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("upstream exploded <html>", { status: 500 });
  try {
    await streamChat("t", { conversation_id: "c1", message: "hi" }, handlers(c));
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(c.errors.length, 1);
  assert.match(c.errors[0], /chat failed: 500/);
  assert.doesNotMatch(c.errors[0], /html/);
});

// --- profile: the customizable assistant name --------------------------------

async function withFetch<T>(
  impl: typeof globalThis.fetch,
  fn: () => Promise<T>,
): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

test("getProfile parses the assistant name", async () => {
  const p = await withFetch(
    async () => new Response('{"assistant_name":"Ada"}', { status: 200 }),
    () => getProfile("t"),
  );
  assert.equal(p.assistant_name, "Ada");
});

test("getProfile parses the onboarded flag", async () => {
  const p = await withFetch(
    async () => new Response('{"assistant_name":"Ada","onboarded":false}', { status: 200 }),
    () => getProfile("t"),
  );
  assert.equal(p.onboarded, false);
});

test("updateProfile omits onboarded when no flag is passed (Settings path)", async () => {
  let sentBody: unknown;
  await withFetch(
    async (_url, init) => {
      sentBody = JSON.parse((init as RequestInit).body as string);
      return new Response('{"assistant_name":"Ada","onboarded":true}', { status: 200 });
    },
    () => updateProfile("t", "Ada"),
  );
  assert.deepEqual(sentBody, { assistant_name: "Ada" });
  assert.ok(!("onboarded" in (sentBody as object)));
});

test("updateProfile sends onboarded when the onboarding flow asks for it", async () => {
  let sentBody: unknown;
  const p = await withFetch(
    async (_url, init) => {
      sentBody = JSON.parse((init as RequestInit).body as string);
      return new Response('{"assistant_name":"Ada","onboarded":true}', { status: 200 });
    },
    () => updateProfile("t", "Ada", { onboarded: true }),
  );
  assert.deepEqual(sentBody, { assistant_name: "Ada", onboarded: true });
  assert.equal(p.onboarded, true);
});

test("updateProfile parses the saved name", async () => {
  const p = await withFetch(
    async () => new Response('{"assistant_name":"Ada"}', { status: 200 }),
    () => updateProfile("t", "Ada"),
  );
  assert.equal(p.assistant_name, "Ada");
});

test("updateProfile raises ApiError with the error body on 400", async () => {
  await assert.rejects(
    withFetch(
      async () => new Response('{"error":"name too long"}', { status: 400 }),
      () => updateProfile("t", "x".repeat(41)),
    ),
    (e) => {
      assert.ok(e instanceof ApiError);
      assert.equal((e as ApiError).status, 400);
      assert.match((e as ApiError).message, /name too long/);
      return true;
    },
  );
});

test("getProfile raises ApiError carrying the status", async () => {
  await assert.rejects(
    withFetch(
      async () => new Response("nope", { status: 500 }),
      () => getProfile("t"),
    ),
    (e) => e instanceof ApiError && (e as ApiError).status === 500,
  );
});

// --- Google connector --------------------------------------------------------

test("connectGoogle parses the auth_url", async () => {
  const r = await withFetch(
    async () =>
      new Response('{"auth_url":"https://accounts.google.com/o/oauth2/v2/auth?x=1"}', {
        status: 200,
      }),
    () => connectGoogle("t"),
  );
  assert.match(r.auth_url, /accounts\.google\.com/);
});

test("connectGoogle raises a 503 ApiError when Google isn't configured", async () => {
  await assert.rejects(
    withFetch(
      async () => new Response('{"error":"google not configured"}', { status: 503 }),
      () => connectGoogle("t"),
    ),
    (e) => {
      assert.ok(e instanceof ApiError);
      assert.equal((e as ApiError).status, 503);
      return true;
    },
  );
});

test("googleStatus parses connected and email", async () => {
  const s = await withFetch(
    async () =>
      new Response(
        '{"connected":true,"email":"a@b.com"}',
        { status: 200 },
      ),
    () => googleStatus("t"),
  );
  assert.equal(s.connected, true);
  assert.equal(s.email, "a@b.com");
});

test("googleStatus normalizes the disconnected shape", async () => {
  const s = await withFetch(
    async () => new Response('{"connected":false,"email":null}', { status: 200 }),
    () => googleStatus("t"),
  );
  assert.equal(s.connected, false);
  assert.equal(s.email, null);
});

test("disconnectGoogle resolves on a 200", async () => {
  await withFetch(
    async () => new Response('{"connected":false}', { status: 200 }),
    () => disconnectGoogle("t"),
  );
});

test("disconnectGoogle raises ApiError carrying the status", async () => {
  await assert.rejects(
    withFetch(
      async () => new Response('{"error":"boom"}', { status: 500 }),
      () => disconnectGoogle("t"),
    ),
    (e) => e instanceof ApiError && (e as ApiError).status === 500,
  );
});

// --- abort: the Stop button and switching conversations mid-stream -----------

test("aborting a hung stream resolves and reports no error", async () => {
  const c = collect();
  const ctrl = new AbortController();
  const orig = globalThis.fetch;
  // One token, then a stall that never ends — a wedged upstream behind a
  // gateway that sets no stream timeout.
  globalThis.fetch = async (_url, init) => {
    const signal = (init as RequestInit).signal!;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('event: token\ndata: {"text":"Hi"}\n\n'),
        );
        signal.addEventListener("abort", () =>
          controller.error(new DOMException("aborted", "AbortError")),
        );
      },
    });
    return new Response(body, { status: 200 });
  };
  try {
    const p = streamChat(
      "t",
      { conversation_id: "c1", message: "hi" },
      handlers(c),
      ctrl.signal,
    );
    await new Promise((r) => setTimeout(r, 10));
    ctrl.abort();
    // Must resolve: this is what re-enables Send after Stop.
    await p;
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(c.tokens.join(""), "Hi");
  assert.deepEqual(c.errors, []);
});

// --- answer provenance: stored model / degraded / tool_calls -----------------

test("listMessages parses answered_model, degraded and tool_calls", async () => {
  const msgs = await withFetch(
    async () =>
      new Response(
        JSON.stringify([
          {
            id: "m1",
            role: "assistant",
            content: "hi",
            answered_model: "qwen2.5:7b",
            degraded: true,
            tool_calls: [{ name: "web_search", arguments: { query: "cats" } }],
          },
        ]),
        { status: 200 },
      ),
    () => listMessages("t", "c1"),
  );
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].answered_model, "qwen2.5:7b");
  assert.equal(msgs[0].degraded, true);
  assert.equal(msgs[0].tool_calls?.[0].name, "web_search");
  assert.equal(msgs[0].tool_calls?.[0].arguments.query, "cats");
});

test("storedDegraded rebuilds the live banner shape for a degraded reload", () => {
  const d = storedDegraded({
    role: "assistant",
    content: "hi",
    answered_model: "qwen2.5:7b",
    degraded: true,
  });
  // Same shape the SSE `degraded` event yields, so MessageRow renders one banner.
  assert.equal(d?.model, "qwen2.5:7b");
  assert.equal(d?.provider, "local");
});

test("storedDegraded returns undefined for a normal (non-degraded) message", () => {
  assert.equal(
    storedDegraded({ role: "assistant", content: "hi", answered_model: "gpt", degraded: false }),
    undefined,
  );
});

// --- memory: knowledge graph + stats -----------------------------------------

test("getMemoryGraph parses nodes, edges, notes and truncated", async () => {
  const g = await withFetch(
    async () =>
      new Response(
        JSON.stringify({
          nodes: [
            { id: "u", label: "You", kind: "identity", degree: 2 },
            { id: "e1", label: "coffee", kind: "entity", degree: 1 },
          ],
          edges: [
            {
              source: "u",
              target: "e1",
              label: "likes",
              confidence: 0.9,
              times_seen: 3,
              first_seen: "2026-01-01",
              last_seen: "2026-07-01",
            },
          ],
          notes: [{ id: "n1", content: "prefers tea in the evening", confidence: 0.7 }],
          truncated: true,
        }),
        { status: 200 },
      ),
    () => getMemoryGraph("t"),
  );
  assert.equal(g.nodes.length, 2);
  assert.equal(g.nodes[0].kind, "identity");
  assert.equal(g.edges[0].label, "likes");
  assert.equal(g.edges[0].times_seen, 3);
  assert.equal(g.notes[0].content, "prefers tea in the evening");
  assert.equal(g.truncated, true);
});

test("getMemoryGraph defaults missing arrays and truncated", async () => {
  const g = await withFetch(
    async () => new Response("{}", { status: 200 }),
    () => getMemoryGraph("t"),
  );
  assert.deepEqual(g.nodes, []);
  assert.deepEqual(g.edges, []);
  assert.deepEqual(g.notes, []);
  assert.equal(g.truncated, false);
});

test("getMemoryGraph raises ApiError carrying the status", async () => {
  await assert.rejects(
    withFetch(
      async () => new Response("nope", { status: 500 }),
      () => getMemoryGraph("t"),
    ),
    (e) => e instanceof ApiError && (e as ApiError).status === 500,
  );
});

test("getMemoryStats parses counts, top_facts and activity", async () => {
  const s = await withFetch(
    async () =>
      new Response(
        JSON.stringify({
          facts: 12,
          episodic: 5,
          conversations: 3,
          top_facts: [
            {
              subject: "You",
              predicate: "work at",
              object: "Metastart",
              confidence: 0.95,
              times_seen: 4,
            },
          ],
          activity: [
            { day: "2026-07-18", count: 2 },
            { day: "2026-07-19", count: 3 },
          ],
          truncated: false,
        }),
        { status: 200 },
      ),
    () => getMemoryStats("t"),
  );
  assert.equal(s.facts, 12);
  assert.equal(s.episodic, 5);
  assert.equal(s.conversations, 3);
  assert.equal(s.top_facts[0].object, "Metastart");
  assert.equal(s.activity.length, 2);
});

test("getMemoryStats defaults zeros and empty arrays for a fresh account", async () => {
  const s = await withFetch(
    async () => new Response("{}", { status: 200 }),
    () => getMemoryStats("t"),
  );
  assert.equal(s.facts, 0);
  assert.equal(s.episodic, 0);
  assert.equal(s.conversations, 0);
  assert.deepEqual(s.top_facts, []);
  assert.deepEqual(s.activity, []);
});

test("getMemoryStats raises ApiError carrying the status", async () => {
  await assert.rejects(
    withFetch(
      async () => new Response("nope", { status: 503 }),
      () => getMemoryStats("t"),
    ),
    (e) => e instanceof ApiError && (e as ApiError).status === 503,
  );
});

// --- providers + capabilities ------------------------------------------------

test("listProviders accepts a bare array", async () => {
  const creds = await withFetch(
    async () =>
      new Response(
        JSON.stringify([
          { id: "p1", provider: "local", auth_type: "api_key", model_id: "qwen2.5:7b", is_active: true, is_lifeboat: false },
        ]),
        { status: 200 },
      ),
    () => listProviders("t"),
  );
  assert.equal(creds.length, 1);
  assert.equal(creds[0].provider, "local");
});

test("listProviders normalizes the {credentials:[]} shape", async () => {
  const creds = await withFetch(
    async () =>
      new Response(
        JSON.stringify({
          credentials: [
            { id: "p2", provider: "anthropic", auth_type: "oauth", model_id: "claude", is_active: false, is_lifeboat: true },
          ],
        }),
        { status: 200 },
      ),
    () => listProviders("t"),
  );
  assert.equal(creds.length, 1);
  assert.equal(creds[0].is_lifeboat, true);
});

test("listProviders raises ApiError carrying the status", async () => {
  await assert.rejects(
    withFetch(
      async () => new Response("nope", { status: 500 }),
      () => listProviders("t"),
    ),
    (e) => e instanceof ApiError && (e as ApiError).status === 500,
  );
});

test("getCapabilities parses provider, model, context window and search", async () => {
  const cap = await withFetch(
    async () =>
      new Response(
        JSON.stringify({
          provider: "local",
          model: "qwen2.5:7b",
          max_context_tokens: 32768,
          source: "discovered",
          web_search: true,
          google_connected: false,
        }),
        { status: 200 },
      ),
    () => getCapabilities("t"),
  );
  assert.equal(cap.provider, "local");
  assert.equal(cap.model, "qwen2.5:7b");
  assert.equal(cap.max_context_tokens, 32768);
  assert.equal(cap.web_search, true);
});

test("getCapabilities raises ApiError carrying the status", async () => {
  await assert.rejects(
    withFetch(
      async () => new Response("nope", { status: 503 }),
      () => getCapabilities("t"),
    ),
    (e) => e instanceof ApiError && (e as ApiError).status === 503,
  );
});

// --- tasks -------------------------------------------------------------------

test("getTasks parses the task list", async () => {
  const tasks = await withFetch(
    async () =>
      new Response(
        JSON.stringify([
          {
            id: "t1",
            title: "Buy milk",
            notes: "",
            status: "open",
            due_date: "2026-07-25",
          },
          { id: "t2", title: "Old", notes: "", status: "done", due_date: null },
        ]),
        { status: 200 },
      ),
    () => getTasks("t"),
  );
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].title, "Buy milk");
  assert.equal(tasks[0].due_date, "2026-07-25");
  assert.equal(tasks[1].status, "done");
});

test("getTasks raises ApiError carrying the status", async () => {
  await assert.rejects(
    withFetch(
      async () => new Response("nope", { status: 500 }),
      () => getTasks("t"),
    ),
    (e) => e instanceof ApiError && (e as ApiError).status === 500,
  );
});

test("createTask sends the body and parses the created task", async () => {
  let sentBody: unknown;
  let sentMethod: string | undefined;
  const task = await withFetch(
    async (_url, init) => {
      sentMethod = (init as RequestInit).method;
      sentBody = JSON.parse((init as RequestInit).body as string);
      return new Response(
        JSON.stringify({
          id: "t3",
          title: "Ship it",
          notes: "",
          status: "open",
          due_date: "2026-08-01",
        }),
        { status: 200 },
      );
    },
    () => createTask("t", { title: "Ship it", due_date: "2026-08-01" }),
  );
  assert.equal(sentMethod, "POST");
  assert.deepEqual(sentBody, { title: "Ship it", due_date: "2026-08-01" });
  assert.equal(task.id, "t3");
});

test("createTask raises ApiError with the error body", async () => {
  await assert.rejects(
    withFetch(
      async () => new Response('{"error":"title required"}', { status: 400 }),
      () => createTask("t", { title: "" }),
    ),
    (e) => {
      assert.ok(e instanceof ApiError);
      assert.equal((e as ApiError).status, 400);
      assert.match((e as ApiError).message, /title required/);
      return true;
    },
  );
});

test("updateTask PATCHes the subset and parses the updated task", async () => {
  let sentBody: unknown;
  let sentMethod: string | undefined;
  const task = await withFetch(
    async (_url, init) => {
      sentMethod = (init as RequestInit).method;
      sentBody = JSON.parse((init as RequestInit).body as string);
      return new Response(
        JSON.stringify({
          id: "t1",
          title: "Buy milk",
          notes: "",
          status: "done",
          due_date: null,
        }),
        { status: 200 },
      );
    },
    () => updateTask("t", "t1", { status: "done" }),
  );
  assert.equal(sentMethod, "PATCH");
  assert.deepEqual(sentBody, { status: "done" });
  assert.equal(task.status, "done");
});

test("updateTask raises ApiError carrying the status", async () => {
  await assert.rejects(
    withFetch(
      async () => new Response('{"error":"not found"}', { status: 404 }),
      () => updateTask("t", "missing", { status: "done" }),
    ),
    (e) => e instanceof ApiError && (e as ApiError).status === 404,
  );
});

test("deleteTask resolves on a 200", async () => {
  let sentMethod: string | undefined;
  await withFetch(
    async (_url, init) => {
      sentMethod = (init as RequestInit).method;
      return new Response('{"deleted":true}', { status: 200 });
    },
    () => deleteTask("t", "t1"),
  );
  assert.equal(sentMethod, "DELETE");
});

test("deleteTask raises ApiError carrying the status", async () => {
  await assert.rejects(
    withFetch(
      async () => new Response('{"error":"boom"}', { status: 500 }),
      () => deleteTask("t", "t1"),
    ),
    (e) => e instanceof ApiError && (e as ApiError).status === 500,
  );
});

// --- conversations: delete ---------------------------------------------------

test("deleteConversation DELETEs and resolves on {deleted:true}", async () => {
  let sentMethod: string | undefined;
  await withFetch(
    async (_url, init) => {
      sentMethod = (init as RequestInit).method;
      return new Response('{"deleted":true}', { status: 200 });
    },
    () => deleteConversation("t", "c1"),
  );
  assert.equal(sentMethod, "DELETE");
});

test("deleteConversation raises ApiError on 404 (not the caller's)", async () => {
  await assert.rejects(
    withFetch(
      async () => new Response('{"error":"not found"}', { status: 404 }),
      () => deleteConversation("t", "missing"),
    ),
    (e) => e instanceof ApiError && (e as ApiError).status === 404,
  );
});

test("deleteConversation raises ApiError carrying the status on 500", async () => {
  await assert.rejects(
    withFetch(
      async () => new Response("boom", { status: 500 }),
      () => deleteConversation("t", "c1"),
    ),
    (e) => e instanceof ApiError && (e as ApiError).status === 500,
  );
});

// --- auth: Google sign-in + session handoff ----------------------------------

test("fetchSession folds a top-level role into the user", async () => {
  let sentInit: RequestInit | undefined;
  const s = await withFetch(
    async (_url, init) => {
      sentInit = init as RequestInit;
      return new Response(
        '{"token":"jwt","user":{"id":"u1","email":"a@b.com"},"role":"admin"}',
        { status: 200 },
      );
    },
    () => fetchSession(),
  );
  assert.equal(s.token, "jwt");
  assert.equal(s.user.id, "u1");
  assert.equal(s.user.role, "admin");
  // The handoff cookie only rides along with credentials:'include'.
  assert.equal(sentInit?.credentials, "include");
});

test("fetchSession keeps a role already on the user object", async () => {
  const s = await withFetch(
    async () =>
      new Response('{"token":"jwt","user":{"id":"u1","role":"member"}}', { status: 200 }),
    () => fetchSession(),
  );
  assert.equal(s.user.role, "member");
});

test("fetchSession raises a 401 ApiError when not signed in", async () => {
  await assert.rejects(
    withFetch(
      async () => new Response('{"error":"no session"}', { status: 401 }),
      () => fetchSession(),
    ),
    (e) => e instanceof ApiError && (e as ApiError).status === 401,
  );
});

test("googleLogin navigates the browser to the consent URL", async () => {
  const orig = globalThis.fetch;
  // jsdom-less node has no window; stub the minimum googleLogin touches.
  const g = globalThis as unknown as { window?: { location: { href: string } } };
  const hadWindow = "window" in globalThis;
  g.window = { location: { href: "" } };
  globalThis.fetch = async () =>
    new Response('{"auth_url":"https://accounts.google.com/o/oauth2/v2/auth?x=1"}', {
      status: 200,
    });
  try {
    await googleLogin();
    assert.match(g.window!.location.href, /accounts\.google\.com/);
  } finally {
    globalThis.fetch = orig;
    if (!hadWindow) delete g.window;
  }
});

// --- admin: allowlist + users ------------------------------------------------

test("listAllowedEmails accepts a bare array and the {emails:[]} shape", async () => {
  const a = await withFetch(
    async () => new Response('[{"email":"x@y.com"}]', { status: 200 }),
    () => listAllowedEmails("t"),
  );
  assert.equal(a[0].email, "x@y.com");
  const b = await withFetch(
    async () => new Response('{"emails":[{"email":"z@y.com"}]}', { status: 200 }),
    () => listAllowedEmails("t"),
  );
  assert.equal(b[0].email, "z@y.com");
});

test("addAllowedEmail POSTs the email", async () => {
  let sentBody: unknown;
  let sentMethod: string | undefined;
  await withFetch(
    async (_url, init) => {
      sentMethod = (init as RequestInit).method;
      sentBody = JSON.parse((init as RequestInit).body as string);
      return new Response('{"email":"x@y.com"}', { status: 200 });
    },
    () => addAllowedEmail("t", "x@y.com"),
  );
  assert.equal(sentMethod, "POST");
  assert.deepEqual(sentBody, { email: "x@y.com" });
});

test("removeAllowedEmail URL-encodes the email in the path", async () => {
  let sentUrl: string | undefined;
  await withFetch(
    async (url) => {
      sentUrl = String(url);
      return new Response("{}", { status: 200 });
    },
    () => removeAllowedEmail("t", "a+b@y.com"),
  );
  assert.match(sentUrl!, /a%2Bb%40y\.com$/);
});

test("setUserRole PATCHes the role", async () => {
  let sentBody: unknown;
  let sentMethod: string | undefined;
  await withFetch(
    async (_url, init) => {
      sentMethod = (init as RequestInit).method;
      sentBody = JSON.parse((init as RequestInit).body as string);
      return new Response('{"id":"u1","role":"admin"}', { status: 200 });
    },
    () => setUserRole("t", "u1", "admin"),
  );
  assert.equal(sentMethod, "PATCH");
  assert.deepEqual(sentBody, { role: "admin" });
});

test("listUsers carries role through", async () => {
  const u = await withFetch(
    async () => new Response('[{"id":"u1","email":"a@b.com","role":"member"}]', { status: 200 }),
    () => listUsers("t"),
  );
  assert.equal(u[0].role, "member");
});

test("admin calls raise ApiError carrying the status (fail closed on 403)", async () => {
  await assert.rejects(
    withFetch(
      async () => new Response('{"error":"forbidden"}', { status: 403 }),
      () => listUsers("t"),
    ),
    (e) => e instanceof ApiError && (e as ApiError).status === 403,
  );
});

test("aborting before the first byte reports no error", async () => {
  const c = collect();
  const ctrl = new AbortController();
  const orig = globalThis.fetch;
  // Stop pressed while the request is still opening: fetch rejects, and that is
  // the user's own doing — not a network failure worth a red banner.
  globalThis.fetch = async () => {
    throw new DOMException("The operation was aborted.", "AbortError");
  };
  try {
    ctrl.abort();
    await streamChat(
      "t",
      { conversation_id: "c1", message: "hi" },
      handlers(c),
      ctrl.signal,
    );
  } finally {
    globalThis.fetch = orig;
  }
  assert.deepEqual(c.errors, []);
});
