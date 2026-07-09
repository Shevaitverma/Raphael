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
PY="${PY:-python}"
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
  for cand in "qwen2.5:7b" "llama2:latest" "gemma3:12b"; do
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
"$PY" "$HERE/sse_client.py" "$GATEWAY" "$TOKEN" "$CID" \
  "In one short sentence, what is the capital of France?" > "$TMP/chat.json"
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
MEMDIMS=$(psql -Atc "SELECT DISTINCT vector_dims(embedding) FROM memories WHERE user_id='$DEV_UID' AND created_at > now() - interval '2 minutes';")
[ "$MEMDIMS" = "768" ] || fail "memory embedding dims = '$MEMDIMS' (want 768)"
MEMMODEL=$(psql -Atc "SELECT DISTINCT embedding_model FROM memories WHERE user_id='$DEV_UID' AND created_at > now() - interval '2 minutes';")
[ -n "$MEMMODEL" ] || fail "memory embedding_model empty"
pass "memories row 768-dim, embedding_model=$MEMMODEL"

echo "== 5. no provider wire-format in the DB =="
VIOL=$(psql -Atc "SELECT count(*) FROM messages WHERE content ~ '(toolu_|call_[A-Za-z0-9]|\"thinking\"|cache_control|redacted_thinking)' OR (tool_calls IS NOT NULL AND tool_calls::text ~ '(toolu_|call_[A-Za-z0-9]|\"thinking\"|\"id\"|cache_control)');")
[ "$VIOL" = "0" ] || fail "$VIOL messages contain provider wire-format"
pass "no toolu_/call_/thinking/cache_control in messages"

echo "== 6. LIFEBOAT: dead anthropic credential (401) must degrade to local =="
curl -s --max-time 8 -X POST "$GATEWAY/api/providers" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"provider":"anthropic","auth_type":"api_key","api_key":"sk-ant-invalid","model_id":"claude-opus-4-8","activate":true}' >/dev/null
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
psql -q -c "UPDATE provider_credentials SET is_active=true WHERE user_id='$DEV_UID' AND provider='local';" >/dev/null
FINAL=$(psql -Atc "SELECT provider||'='||is_active FROM provider_credentials WHERE user_id='$DEV_UID';")
pass "restored: $FINAL"

echo ""
echo "ALL E2E ASSERTIONS PASSED"
