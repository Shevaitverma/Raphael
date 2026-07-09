"""Minimal SSE driver for the gateway's /api/chat. Prints a JSON summary.

Usage:
    python sse_client.py <gateway_url> <token> <conversation_id> <message>

Records the elapsed-ms arrival time of every SSE frame so callers can assert
that tokens stream incrementally (spread over time) rather than arriving as a
single terminal burst. Uses only the standard library.
"""
import json
import sys
import time
import urllib.request

gateway, token, cid, message = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

body = json.dumps({"conversation_id": cid, "message": message}).encode()
req = urllib.request.Request(
    gateway + "/api/chat",
    data=body,
    headers={
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    },
    method="POST",
)

t0 = time.time()
events = []          # (elapsed_ms, event, data_str)
cur_event = None
resp = urllib.request.urlopen(req, timeout=300)
for raw in resp:
    line = raw.decode("utf-8", "replace").rstrip("\r\n")
    if line.startswith("event:"):
        cur_event = line[len("event:"):].strip()
    elif line.startswith("data:"):
        data = line[len("data:"):].strip()
        events.append((round((time.time() - t0) * 1000), cur_event, data))

def of(kind):
    return [e for e in events if e[1] == kind]

toks, done, degraded, error = of("token"), of("done"), of("degraded"), of("error")
answer = "".join(json.loads(d).get("text", "") for _, ev, d in events if ev == "token")

print(json.dumps({
    "http_status": resp.status,
    "n_events": len(events),
    "n_token": len(toks),
    "n_done": len(done),
    "n_degraded": len(degraded),
    "n_error": len(error),
    "first_token_ms": toks[0][0] if toks else None,
    "last_token_ms": toks[-1][0] if toks else None,
    "token_spread_ms": (toks[-1][0] - toks[0][0]) if len(toks) >= 2 else 0,
    "done_payload": json.loads(done[0][2]) if done else None,
    "degraded_payload": json.loads(degraded[0][2]) if degraded else None,
    "error_payload": json.loads(error[0][2]) if error else None,
    "answer_preview": answer[:200],
    "answer_len": len(answer),
    "token_arrivals_ms": [e[0] for e in toks[:8]],
}, indent=2))
