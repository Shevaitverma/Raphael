// Runnable self-check for the two non-trivial pure paths: the SSE accumulator
// and the message splitter. No framework:  node src/selfcheck.js
import assert from "node:assert/strict";

// pipeline.js imports config.js, which exits unless the owner env is set.
process.env.INTERNAL_TOKEN = "x";
process.env.WHATSAPP_OWNER_JID = "1@s.whatsapp.net";
process.env.WHATSAPP_OWNER_USER_ID = "u1";

const { splitMessage } = await import("./split.js");
const { makeSseAccumulator } = await import("./pipeline.js");

// --- splitMessage ---
assert.deepEqual(splitMessage("hi", 10), ["hi"], "short = one part");
assert.deepEqual(
  splitMessage("aaaa\n\nbbbb", 5),
  ["aaaa", "bbbb"],
  "splits on paragraph boundary"
);
// a single paragraph longer than max is hard-chopped
assert.deepEqual(splitMessage("abcdef", 3), ["abc", "def"], "hard chop over-long para");
for (const part of splitMessage("x".repeat(100) + "\n\n" + "y".repeat(100), 40)) {
  assert.ok(part.length <= 40, "no part exceeds max");
}

// --- SSE accumulator: tokens buffer, degraded noted, done resolves ---
const a = makeSseAccumulator();
a.feed('event: token\ndata: {"text":"Hel"}\n\n');
a.feed('event: token\ndata: {"text":"lo"}\n\n');
a.feed('event: degraded\ndata: {"reason":"x","provider":"ollama","model":"q"}\n\n');
a.feed('event: done\ndata: {"provider":"ollama","model":"q","message_id":"m1"}\n\n');
assert.deepEqual(a.result(), { text: "Hello", degraded: true, error: false });

// chunk boundary splitting a line mid-way must still parse
const b = makeSseAccumulator();
b.feed('event: tok');
b.feed('en\ndata: {"text":"Hi"}\n\nevent: done\ndata: {}\n\n');
assert.equal(b.result().text, "Hi", "reassembles across chunk boundary");

// error event discards buffered text and never leaks the message
const c = makeSseAccumulator();
c.feed('event: token\ndata: {"text":"secret partial"}\n\n');
c.feed('event: error\ndata: {"message":"boom stacktrace"}\n\n');
const r = c.result();
assert.deepEqual(r, { text: "", degraded: false, error: true }, "error wipes text");
assert.ok(!JSON.stringify(r).includes("boom"), "raw error never in result");

console.log("selfcheck: all assertions passed");
