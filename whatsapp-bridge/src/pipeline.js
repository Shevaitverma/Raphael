import { config } from "./config.js";

// Talk to the gateway's internal ingress and collapse its SSE stream into one
// buffered reply. Events (frozen contract):
//   token {text}            -> append
//   degraded {reason,...}   -> note the fallback-model banner
//   error {message}         -> discard everything, return a failure marker.
//                              The raw message is NEVER surfaced to WhatsApp.
//   done {provider,model,message_id} -> resolve
//
// ponytail: hand-rolled line parser over fetch's byte stream. No SSE client dep
// for a single well-known producer; swap in `eventsource-parser` only if the
// gateway starts emitting multi-line data / comments / retry fields.
export async function ask({ user_id, conversation_id, message, search }) {
  let res;
  try {
    res = await fetch(`${config.gatewayUrl}/internal/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": config.internalToken,
      },
      body: JSON.stringify({ user_id, conversation_id, message, search }),
    });
  } catch (e) {
    console.error("[pipeline] request failed:", e.message);
    return { text: "", degraded: false, error: true };
  }

  if (!res.ok || !res.body) {
    console.error(`[pipeline] gateway returned ${res.status}`);
    return { text: "", degraded: false, error: true };
  }

  const acc = makeSseAccumulator();
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    acc.feed(decoder.decode(chunk, { stream: true }));
  }
  return acc.result();
}

// Incremental SSE frame reader. Kept pure (no fetch, no I/O) so it can be
// self-checked. Handles chunk boundaries splitting mid-line and \r\n.
export function makeSseAccumulator() {
  let text = "";
  let degraded = false;
  let error = false;
  let buf = "";
  let event = null;

  const handle = (evt, data) => {
    let payload = {};
    try {
      payload = data ? JSON.parse(data) : {};
    } catch {
      return; // malformed data line: ignore
    }
    switch (evt) {
      case "token":
        if (typeof payload.text === "string") text += payload.text;
        break;
      case "degraded":
        degraded = true;
        console.log(
          `[pipeline] degraded: ${payload.reason || "?"} (${payload.provider || "?"}/${payload.model || "?"})`
        );
        break;
      case "error":
        // Log for the operator; never let payload.message reach WhatsApp.
        console.error(`[pipeline] error event: ${payload.message || "(none)"}`);
        error = true;
        break;
      case "done":
        console.log(
          `[pipeline] done: ${payload.provider || "?"}/${payload.model || "?"} msg=${payload.message_id || "?"}`
        );
        break;
    }
  };

  return {
    feed(str) {
      buf += str;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          event = null; // blank line = end of one SSE frame
        } else if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          handle(event, line.slice(5).trim());
        }
        // other fields (id:, retry:, comments) ignored
      }
    },
    result() {
      if (error) return { text: "", degraded, error: true };
      return { text, degraded, error: false };
    },
  };
}
