import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ApiError,
  connectGoogle,
  disconnectGoogle,
  getProfile,
  googleStatus,
  listMessages,
  storedDegraded,
  streamChat,
  updateProfile,
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

test("googleStatus parses connected, email and scopes", async () => {
  const s = await withFetch(
    async () =>
      new Response(
        '{"connected":true,"email":"a@b.com","scopes":["calendar.readonly","userinfo.email"]}',
        { status: 200 },
      ),
    () => googleStatus("t"),
  );
  assert.equal(s.connected, true);
  assert.equal(s.email, "a@b.com");
  assert.deepEqual(s.scopes, ["calendar.readonly", "userinfo.email"]);
});

test("googleStatus normalizes the disconnected shape", async () => {
  const s = await withFetch(
    async () => new Response('{"connected":false,"email":null,"scopes":[]}', { status: 200 }),
    () => googleStatus("t"),
  );
  assert.equal(s.connected, false);
  assert.equal(s.email, null);
  assert.deepEqual(s.scopes, []);
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
