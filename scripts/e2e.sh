#!/usr/bin/env bash
# End-to-end acceptance test for the Raphael walking skeleton.
#
# Drives: dev-login -> create conversation -> chat (SSE) -> Postgres assertions
# -> lifeboat (dead credential 401) -> transient fault (429, no lifeboat) and
# asserts on the real output at every step. Exits non-zero on the first failure.
#
# Prereqrequisites: all services running (scripts/dev.sh) and the Postgres
# container named `raphael_db` up (docker compose up -d). Uses only curl,
# docker, and python (stdlib).
set -uo pipefail

GATEWAY="${GATEWAY_URL:-http://localhost:8080}"
AGENT="${AGENT_SVC_URL:-http://localhost:8000}"
OLLAMA="${OLLAMA_BASE_URL:-http://localhost:11434/v1}"
DEV_UID="00000000-0000-0000-0000-000000000001"
PY="${PY:-$(command -v python3 || command -v python)}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
STUB_PID=""

psql() { docker exec -i raphael_db psql -U raphael -d raphael "$@"; }
fail() { echo "FAIL: $*"; cleanup; exit 1; }
pass() { echo "  PASS: $*"; }
jget() { "$PY" -c "import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$1" "$2"; }
cleanup() { [ -n "$STUB_PID" ] && kill "$STUB_PID" >/dev/null 2>&1; rm -rf "$TMP"; }
trap cleanup EXIT

echo "== 0. health checks =="
for pair in "gateway:8080" "user-svc:8081" "conv-svc:8082" "agent-svc:8000"; do
  name="${pair%%:*}"; port="${pair##*:}"
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://localhost:$port/healthz")
  [ "$code" = "200" ] || fail "$name /healthz returned $code"
  pass "$name /healthz 200"
done

echo "== 0b. select an available local Ollama model =="
TAGS=$(curl -s --max-time 10 "${OLLAMA%/v1}/api/tags")
MODEL="${LOCAL_MODEL:-}"
if [ -z "$MODEL" ]; then
  for cand in "qwen3.5:latest" "qwen3.6:latest" "llama2:latest" "gemma3:12b"; do
    echo "$TAGS" | grep -q "\"$cand\"" && MODEL="$cand" && break
  done
fi
[ -z "$MODEL" ] && MODEL=$(echo "$TAGS" | "$PY" -c "import json,sys;m=json.load(sys.stdin)['models'];print(m[0]['name'] if m else '')")
[ -z "$MODEL" ] && fail "no Ollama model available"
# Reset to a clean local-only state: drop any leftover paid creds first, then
# point the local row at the chosen model and make it the single active row.
psql -q -c "DELETE FROM provider_credentials WHERE user_id='$DEV_UID' AND provider IN ('anthropic','openai_compat');" >/dev/null
psql -q -c "UPDATE provider_credentials SET model_id='$MODEL', is_active=true WHERE user_id='$DEV_UID' AND provider='local';" >/dev/null
pass "active local credential -> $MODEL"

echo "== 1. dev-login =="
curl -s --max-time 8 -X POST "$GATEWAY/auth/dev-login" -H 'Content-Type: application/json' \
  -d '{"email":"dev@raphael.local"}' > "$TMP/login.json"
TOKEN=$(jget "$TMP/login.json" token)
[ -n "$TOKEN" ] || fail "no token minted"
pass "JWT minted"

echo "== 2. create conversation =="
curl -s --max-time 8 -X POST "$GATEWAY/api/conversations" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"title":"e2e"}' > "$TMP/conv.json"
CID=$(jget "$TMP/conv.json" id)
[ -n "$CID" ] || fail "no conversation id"
pass "conversation $CID"

echo "== 3. chat SSE (expect incremental tokens + exactly one done) =="
# The message MUST state something durable about the user. Step 4 asserts a
# fresh embedded row, and the only writer is LLM extraction — for a bare "what
# is the capital of France?" extract.py yields {"items": []} and is CORRECT to
# (extract.py:22). Phrased like extract.py's own worked example so a 7B has the
# best shot at it.
"$PY" "$HERE/sse_client.py" "$GATEWAY" "$TOKEN" "$CID" \
  "I moved to Berlin last month and I work at Acme. In one short sentence, what is the capital of France?" > "$TMP/chat.json"
cat "$TMP/chat.json"
"$PY" - "$TMP/chat.json" <<'PYEOF' || fail "chat SSE assertions failed"
import json,sys
d=json.load(open(sys.argv[1]))
assert d["http_status"]==200, d["http_status"]
assert d["n_token"]>=1, "need >=1 token"
assert d["n_done"]==1, "need exactly one done"
assert d["n_error"]==0, "unexpected error event"
assert d["token_spread_ms"]>0 or d["n_token"]==1, "tokens must arrive incrementally"
assert d["done_payload"]["message_id"], "done must carry a message_id"
print("  PASS: %d tokens over %dms, 1 done, model=%s"%(d["n_token"],d["token_spread_ms"],d["done_payload"]["model"]))
PYEOF

echo "== 4. Postgres persistence (user + assistant messages, 768-dim memory) =="
ROLES=$(psql -Atc "SELECT string_agg(role,',' ORDER BY created_at) FROM messages WHERE conversation_id='$CID';")
echo "$ROLES" | grep -q "user" || fail "no user message persisted"
echo "$ROLES" | grep -q "assistant" || fail "no assistant message persisted"
pass "messages persisted: $ROLES"
# Both tables, because extraction splits the exchange across them: triples land
# in `facts`, notes in `memories`, and which one a 7B produces is not ours to
# pin. Either proves the embed+write path.
# Keyed on last_seen, NOT first_seen/created_at: this suite is not run against a
# virgin DB. On a re-run the same facts already exist, so facts_triple_unique's
# ON CONFLICT DO UPDATE correctly REINFORCES (times_seen+1, last_seen=now()) and
# inserts nothing — leaving first_seen at its original value. Asserting on
# first_seen therefore only passes the very first time and fails forever after,
# on correct behaviour. last_seen moves on both insert and reinforce, so it means
# what we actually want to assert: extraction ran and wrote this turn.
FRESH="SELECT DISTINCT vector_dims(embedding)::text || '|' || embedding_model FROM (
         SELECT embedding, embedding_model, last_seen FROM memories WHERE user_id='$DEV_UID'
         UNION ALL
         SELECT embedding, embedding_model, last_seen FROM facts WHERE user_id='$DEV_UID'
       ) r WHERE last_seen > now() - interval '2 minutes';"
# Extraction runs AFTER the SSE stream closes (workflow.py:9-12), so step 3
# returning does not mean the row exists yet. Poll; a single query races it.
MEM=""
for _ in $(seq 1 30); do
  MEM=$(psql -Atc "$FRESH")
  [ -n "$MEM" ] && break
  sleep 1
done
[ -n "$MEM" ] || fail "no memory/fact row written within 30s of the turn"
[ "${MEM%%|*}" = "768" ] || fail "memory embedding dims = '${MEM%%|*}' (want 768)"
[ -n "${MEM#*|}" ] || fail "memory embedding_model empty"
pass "memory row 768-dim, embedding_model=${MEM#*|}"

echo "== 4b. search turn: the tool call must land as OUR neutral shape =="
# Driven at agent-svc directly, not the gateway: proxy.go rebuilds the upstream
# body from a typed struct, so this asserts the tool-call path without waiting
# on a field passthrough it does not need.
# Gated on agent-svc's OWN answer, never on e2e's env: `web_search` means a key
# is configured AND the tool is actually wired (main.py:52-63), `native_tools`
# means the model can be told about it. Both true is exactly the Tier 1
# precondition, so this section arms itself the moment search lands and skips
# loudly until then — instead of going red for a feature nobody built yet.
CAPS=$(curl -s --max-time 8 "$AGENT/capabilities?user_id=$DEV_UID")
WEBSEARCH=$(echo "$CAPS" | "$PY" -c "import json,sys;print(json.load(sys.stdin).get('web_search'))" 2>/dev/null)
NATIVE=$(echo "$CAPS" | "$PY" -c "import json,sys;print(json.load(sys.stdin).get('native_tools'))" 2>/dev/null)
if [ "$WEBSEARCH" != "True" ]; then
  echo "  SKIP: agent-svc reports web_search=$WEBSEARCH — search off, no tool call to assert"
elif [ "$NATIVE" != "True" ]; then
  echo "  SKIP: $MODEL reports native_tools=$NATIVE — Tier 2 has no tool call"
else
  curl -s -N --max-time 180 -X POST "$AGENT/chat" -H 'Content-Type: application/json' \
    -d "{\"user_id\":\"$DEV_UID\",\"conversation_id\":\"$CID\",\"message\":\"Search the web and tell me one thing that happened in the news today.\",\"search\":true}" \
    > "$TMP/search.sse"
  grep -q "^event: done" "$TMP/search.sse" || fail "search turn never completed: $(head -c 400 "$TMP/search.sse")"
  # count(col) counts NON-NULL, so this is 0 the moment _post_message goes back
  # to posting {role, content} only — which is the whole point of the assertion.
  TC=$(psql -Atc "SELECT count(tool_calls) FROM messages WHERE conversation_id='$CID';")
  [ "${TC:-0}" -ge 1 ] || fail "search turn wrote no tool_calls — conv-svc got role/content only"
  pass "neutral tool_calls persisted and accepted by conv-svc (count=$TC)"
fi

echo "== 5. no provider wire-format in the DB =="
# The content half must stay broad: it is the ONLY guard on a thinking block
# leaking into messages.content, and that path is live — anthropic_api.py asks
# for thinking={"type":"adaptive"} and drops the blocks by hand. Length-anchoring
# the ids does not work either: `call_abc123` and `call_1` are the real fixtures
# in tests/test_tools_forward.py, which asserts the stricter `"call_" not in
# blob` — e2e must not enforce less than the unit test it backstops.
# `thinking` is anchored on the JSON KEY rather than the bare word, which keeps
# both properties: it catches thinking + redacted_thinking blocks, and does NOT
# match the title `Do AI models really do "thinking"?` (verified against this DB).
# ponytail: `call_[A-Za-z0-9]` still matches https://x.com/call_1, harmless today
# because no untrusted third-party text reaches content (main.py hardcodes
# caps["web_search"]=False). When citations land, anchor call_ on its JSON key
# too — do NOT fix it by shortening the pattern's reach.
# ponytail: the tool_calls half stringifies the column and bans the literal
# "id", so a tool argument (or a search query) of exactly `id` trips it. Name
# arguments accordingly; a JSON-key-aware checker is the upgrade if that bites.
VIOL=$(psql -Atc "SELECT count(*) FROM messages WHERE content ~ '(\"type\":\s*\"(redacted_)?thinking\"|toolu_|call_[A-Za-z0-9]|cache_control)' OR (tool_calls IS NOT NULL AND tool_calls::text ~ '(toolu_|call_[A-Za-z0-9]|\"thinking\"|\"redacted_thinking\"|\"id\"|cache_control)');")
[ "$VIOL" = "0" ] || fail "$VIOL messages contain provider wire-format"
pass "no toolu_/call_/thinking/cache_control in messages"

echo "== 6. LIFEBOAT: dead anthropic credential (401) must degrade to local =="
curl -s --max-time 8 -X POST "$GATEWAY/api/providers" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"provider":"anthropic","auth_type":"api_key","api_key":"sk-ant-invalid","model_id":"claude-opus-4-8","activate":true}' >/dev/null
# Activating anthropic deactivated local (one active per user). Now designate the
# inactive local row as the lifeboat — the resolver falls back to is_lifeboat, not
# to a hardcoded provider='local'.
psql -q -c "UPDATE provider_credentials SET is_lifeboat=true WHERE user_id='$DEV_UID' AND provider='local';" >/dev/null
BEFORE=$(psql -Atc "SELECT string_agg(provider||'='||is_active,',' ORDER BY provider) FROM provider_credentials WHERE user_id='$DEV_UID';")
"$PY" "$HERE/sse_client.py" "$GATEWAY" "$TOKEN" "$CID" \
  "In one short sentence, what is the capital of Japan?" > "$TMP/lifeboat.json"
cat "$TMP/lifeboat.json"
"$PY" - "$TMP/lifeboat.json" <<'PYEOF' || fail "lifeboat assertions failed"
import json,sys
d=json.load(open(sys.argv[1]))
assert d["n_degraded"]==1, "expected a degraded event"
assert d["n_error"]==0, "no error expected on lifeboat"
assert d["n_token"]>=1, "lifeboat must still stream an answer"
assert d["n_done"]==1, "expected one done"
assert d["degraded_payload"]["provider"]=="local", d["degraded_payload"]
print("  PASS: degraded->%s, answered by %s"%(d["degraded_payload"]["model"],d["done_payload"]["model"]))
PYEOF
AFTER=$(psql -Atc "SELECT string_agg(provider||'='||is_active,',' ORDER BY provider) FROM provider_credentials WHERE user_id='$DEV_UID';")
[ "$BEFORE" = "$AFTER" ] || fail "is_active changed by lifeboat: '$BEFORE' -> '$AFTER'"
pass "is_active unchanged after lifeboat: $AFTER"

echo "== 7. TRANSIENT 429: must error, must NOT fire the lifeboat =="
"$PY" "$HERE/stub_429.py" 9099 >/dev/null 2>&1 &
STUB_PID=$!
sleep 1
curl -s --max-time 8 -X POST "$GATEWAY/api/providers" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"provider":"openai_compat","auth_type":"api_key","api_key":"sk-x","base_url":"http://127.0.0.1:9099/v1","model_id":"stub","activate":true}' >/dev/null
B2=$(psql -Atc "SELECT string_agg(provider||'='||is_active,',' ORDER BY provider) FROM provider_credentials WHERE user_id='$DEV_UID';")
"$PY" "$HERE/sse_client.py" "$GATEWAY" "$TOKEN" "$CID" "should error" > "$TMP/t429.json"
cat "$TMP/t429.json"
"$PY" - "$TMP/t429.json" <<'PYEOF' || fail "429 assertions failed"
import json,sys
d=json.load(open(sys.argv[1]))
assert d["n_error"]==1, "expected an error event"
assert d["n_degraded"]==0, "lifeboat must NOT fire on 429"
assert d["n_token"]==0, "no tokens on transient error"
assert "429" in json.dumps(d["error_payload"]), d["error_payload"]
print("  PASS: error (no lifeboat) on 429")
PYEOF
A2=$(psql -Atc "SELECT string_agg(provider||'='||is_active,',' ORDER BY provider) FROM provider_credentials WHERE user_id='$DEV_UID';")
[ "$B2" = "$A2" ] || fail "is_active changed by 429 path"
pass "is_active unchanged after 429: $A2"
kill "$STUB_PID" >/dev/null 2>&1; STUB_PID=""

echo "== 8. restore local as the active credential =="
psql -q -c "DELETE FROM provider_credentials WHERE user_id='$DEV_UID' AND provider IN ('anthropic','openai_compat');" >/dev/null
# Clear the lifeboat flag as we reactivate local — a row cannot be both active
# and the lifeboat (active_is_not_lifeboat CHECK).
psql -q -c "UPDATE provider_credentials SET is_active=true, is_lifeboat=false WHERE user_id='$DEV_UID' AND provider='local';" >/dev/null
FINAL=$(psql -Atc "SELECT provider||'='||is_active FROM provider_credentials WHERE user_id='$DEV_UID';")
pass "restored: $FINAL"

echo ""
echo "ALL E2E ASSERTIONS PASSED"
