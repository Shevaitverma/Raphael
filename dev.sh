#!/usr/bin/env bash
# Start the whole Raphael local dev stack, correctly, every time.
#
#   ./dev.sh            # infra + all five services
#   NO_WEB=1 ./dev.sh   # skip the Next.js UI
#
# Logs go to ./logs/<service>.log (JSON lines). Tail them with ./logs.sh.
# Stop with ./stop.sh.
#
# Three bugs this script exists to kill permanently:
#   1. Config drift  — .env is sourced ONCE and exported, so every service sees
#      byte-identical config. (We once ran gateway with a stale
#      GOOGLE_REDIRECT_URI and user-svc with the new one for hours.)
#   2. Poisoned web bundle — NEXT_PUBLIC_GATEWAY_URL must NOT reach the web
#      process. A process env var beats web/.env.local and bakes an absolute
#      localhost:8080 URL into the client, breaking the same-origin proxy.
#      web is started with `env -u NEXT_PUBLIC_GATEWAY_URL`. See the comment in
#      .env next to that variable.
#   3. Stale port squatters — every port is force-freed before we start.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS="$ROOT/logs"
mkdir -p "$LOGS"
cd "$ROOT"

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; Z=$'\033[0m'
else B=""; G=""; R=""; Y=""; Z=""; fi
say() { printf '%s\n' "$*"; }

# ---------------------------------------------------------------- 1. config --
[ -f "$ROOT/.env" ] || { say "${R}FATAL${Z}: no .env at $ROOT/.env (cp .env.example .env)"; exit 1; }
set -a
# shellcheck disable=SC1091
. "$ROOT/.env"
set +a

: "${GATEWAY_PORT:=8080}"
: "${USER_SVC_PORT:=8081}"
: "${CONV_SVC_PORT:=8082}"
: "${AGENT_SVC_PORT:=8000}"
: "${WEB_PORT:=3000}"
: "${DATABASE_URL:=postgresql://raphael:raphael@localhost:5433/raphael}"
: "${REDIS_URL:=redis://localhost:6379/0}"
: "${USER_SVC_URL:=http://localhost:$USER_SVC_PORT}"
: "${CONV_SVC_URL:=http://localhost:$CONV_SVC_PORT}"
: "${AGENT_SVC_URL:=http://localhost:$AGENT_SVC_PORT}"
export GATEWAY_PORT USER_SVC_PORT CONV_SVC_PORT AGENT_SVC_PORT WEB_PORT
export DATABASE_URL REDIS_URL USER_SVC_URL CONV_SVC_URL AGENT_SVC_URL

for v in CREDENTIAL_ENC_KEY INTERNAL_TOKEN; do
  eval "val=\${$v:-}"
  [ -n "$val" ] || { say "${R}FATAL${Z}: $v is empty in .env"; exit 1; }
done

VENV_PY="$ROOT/agent-svc/.venv/bin/python"   # bare `python` is NOT on PATH here.
[ -x "$VENV_PY" ] || { say "${R}FATAL${Z}: no venv at $VENV_PY — python3 -m venv agent-svc/.venv && $VENV_PY -m pip install -r agent-svc/requirements.txt"; exit 1; }

PM="npm"
if [ -f "$ROOT/web/pnpm-lock.yaml" ] && command -v pnpm >/dev/null 2>&1; then PM="pnpm"; fi

# ------------------------------------------------------------ 2. free ports --
say "${B}== freeing ports ==${Z}"
for p in "$GATEWAY_PORT" "$USER_SVC_PORT" "$CONV_SVC_PORT" "$AGENT_SVC_PORT" "$WEB_PORT"; do
  pids="$(lsof -ti tcp:"$p" 2>/dev/null)"
  if [ -n "$pids" ]; then
    printf '%s' "$pids" | xargs kill -9 2>/dev/null
    say "  :$p  killed $(printf '%s' "$pids" | tr '\n' ' ')"
  fi
done
rm -f "$LOGS"/*.pid

# ------------------------------------------------------------- 3. infra up ---
say "${B}== docker deps ==${Z}"
docker compose up -d postgres redis >/dev/null || { say "${R}FATAL${Z}: docker compose up postgres redis failed"; exit 1; }

printf '  waiting for postgres health '
ok=""
for _ in $(seq 1 60); do
  st="$(docker inspect -f '{{.State.Health.Status}}' raphael_db 2>/dev/null)"
  [ "$st" = "healthy" ] && { ok=1; break; }
  printf '.'; sleep 1
done
[ -n "$ok" ] || { printf '\n'; say "${R}FATAL${Z}: raphael_db never became healthy"; exit 1; }
printf ' %shealthy%s\n' "$G" "$Z"

# --------------------------------------------------------------- 4. build ----
say "${B}== building go services ==${Z}"
for svc in user-svc conv-svc gateway; do
  ( cd "$ROOT/$svc" && go build -o "$svc" ./... ) || { say "${R}FATAL${Z}: go build $svc failed"; exit 1; }
  say "  built $svc"
done

# --------------------------------------------------------------- 5. start ----
# start <name> <workdir> <cmd...>  — stdout+stderr to logs/<name>.log
start() {
  local name="$1" dir="$2"; shift 2
  ( cd "$dir" && exec "$@" ) >"$LOGS/$name.log" 2>&1 &
  echo $! >"$LOGS/$name.pid"
  say "  started $name (pid $!) -> logs/$name.log"
}

# wait_up <port> <timeout> — /health, then /healthz, then a plain TCP probe so
# this works before the parallel /health work lands (and for web, which has none).
wait_up() {
  local port="$1" timeout="$2" i=0
  while [ "$i" -lt "$timeout" ]; do
    if curl -fsS -m 2 "http://127.0.0.1:$port/health"  >/dev/null 2>&1 \
    || curl -fsS -m 2 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 \
    || nc -z 127.0.0.1 "$port" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1; i=$((i + 1))
  done
  return 1
}

say "${B}== services ==${Z}"
start user-svc  "$ROOT/user-svc"      "$ROOT/user-svc/user-svc"
start conv-svc  "$ROOT/conv-svc"      "$ROOT/conv-svc/conv-svc"
start gateway   "$ROOT/gateway"       "$ROOT/gateway/gateway"
# agent-svc: venv python, run from src/ so `main:app` resolves.
start agent-svc "$ROOT/agent-svc/src" "$VENV_PY" -m uvicorn main:app --host 127.0.0.1 --port "$AGENT_SVC_PORT"
if [ -z "${NO_WEB:-}" ]; then
  # env -u: see header note 2. Do not "simplify" this away.
  start web "$ROOT/web" env -u NEXT_PUBLIC_GATEWAY_URL "$PM" run dev
fi

# ---------------------------------------------------------------- 6. health --
say ""
say "${B}== health ==${Z}"
NAMES="user-svc conv-svc gateway agent-svc"
[ -z "${NO_WEB:-}" ] && NAMES="$NAMES web"
failed=0
for name in $NAMES; do
  case "$name" in
    user-svc)  port="$USER_SVC_PORT";  budget=30 ;;
    conv-svc)  port="$CONV_SVC_PORT";  budget=30 ;;
    gateway)   port="$GATEWAY_PORT";   budget=30 ;;
    agent-svc) port="$AGENT_SVC_PORT"; budget=90 ;;  # warms the embedding model
    web)       port="$WEB_PORT";       budget=90 ;;  # next dev first compile
  esac
  if wait_up "$port" "$budget"; then
    printf '  %-10s :%-5s %sUP%s\n' "$name" "$port" "$G" "$Z"
  else
    printf '  %-10s :%-5s %sFAILED%s  (tail logs/%s.log)\n' "$name" "$port" "$R" "$Z" "$name"
    failed=$((failed + 1))
  fi
done

say ""
if [ "$failed" -eq 0 ]; then
  say "${G}stack up${Z}   web http://localhost:$WEB_PORT   gateway http://localhost:$GATEWAY_PORT"
else
  say "${Y}$failed service(s) failed${Z}"
fi
say "logs: ./logs.sh        stop: ./stop.sh"
exit "$failed"
