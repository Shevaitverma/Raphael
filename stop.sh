#!/usr/bin/env bash
# Stop the host services started by ./dev.sh.
#
#   ./stop.sh         # host processes only — containers untouched
#   ./stop.sh --all   # also `docker compose stop postgres redis`
#
# --all uses `stop`, never `down`: `down` would remove containers and is one
# typo away from taking the pgdata volume (the real database) with it.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS="$ROOT/logs"
cd "$ROOT"

if [ -f "$ROOT/.env" ]; then set -a; . "$ROOT/.env"; set +a; fi
: "${GATEWAY_PORT:=8080}"; : "${USER_SVC_PORT:=8081}"; : "${CONV_SVC_PORT:=8082}"
: "${AGENT_SVC_PORT:=8000}"; : "${WEB_PORT:=3000}"

# pid files first (graceful), then by port (the child that outlived its parent —
# `next dev` and uvicorn both fork workers that keep the socket).
for f in "$LOGS"/*.pid; do
  [ -f "$f" ] || continue
  pid="$(cat "$f")"
  if [ -n "$pid" ] && kill "$pid" 2>/dev/null; then
    echo "stopped $(basename "$f" .pid) (pid $pid)"
  fi
  rm -f "$f"
done

for p in "$GATEWAY_PORT" "$USER_SVC_PORT" "$CONV_SVC_PORT" "$AGENT_SVC_PORT" "$WEB_PORT"; do
  pids="$(lsof -ti tcp:"$p" 2>/dev/null)"
  if [ -n "$pids" ]; then
    printf '%s' "$pids" | xargs kill -9 2>/dev/null
    echo "freed :$p"
  fi
done

if [ "${1:-}" = "--all" ]; then
  echo "stopping containers (postgres, redis) ..."
  docker compose stop postgres redis
fi

echo "done."
