import { test } from "node:test";
import assert from "node:assert/strict";
import { streamChat, type Degraded, type Done } from "../lib/gateway.ts";

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

async function run(payload: string, chunkSize: number): Promise<Collected> {
  const c: Collected = { tokens: [], degraded: [], done: [], errors: [] };
  const orig = globalThis.fetch;
  globalThis.fetch = async () => sseResponse(payload, chunkSize);
  try {
    await streamChat(
      "fake-token",
      { conversation_id: "c1", message: "hi" },
      {
        onToken: (t) => c.tokens.push(t),
        onDegraded: (d) => c.degraded.push(d),
        onDone: (d) => c.done.push(d),
        onError: (m) => c.errors.push(m),
      },
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
  const c: Collected = { tokens: [], degraded: [], done: [], errors: [] };
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  try {
    await streamChat(
      "t",
      { conversation_id: "c1", message: "hi" },
      {
        onToken: (t) => c.tokens.push(t),
        onDegraded: (d) => c.degraded.push(d),
        onDone: (d) => c.done.push(d),
        onError: (m) => c.errors.push(m),
      },
    );
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(c.errors.length, 1);
  assert.match(c.errors[0], /gateway/i);
});
