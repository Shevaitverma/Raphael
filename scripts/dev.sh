#!/usr/bin/env bash
# Start every Raphael service on the host for the walking skeleton.
#
# Infrastructure (Postgres :5433, Redis :6379) must already be up via
# `docker compose up -d postgres redis`. Builds the Go binaries, ensures the agent-svc venv and
# web deps exist, then launches all five services in the background, logging to
# ./logs/. On Windows run this from Git Bash; Go must be on PATH
# (export PATH="$PATH:/c/Program Files/Go/bin").
#
# Usage:  bash scripts/dev.sh          # all five
#         NO_WEB=1 bash scripts/dev.sh # skip the Next.js UI
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS="$ROOT/logs"; mkdir -p "$LOGS"
cd "$ROOT"

# --- load .env if present, else documented defaults --------------------------
if [ -f "$ROOT/.env" ]; then set -a; . "$ROOT/.env"; set +a; fi
: "${DATABASE_URL:=postgresql://raphael:raphael@localhost:5433/raphael}"
: "${REDIS_URL:=redis://localhost:6379/0}"
: "${JWT_SECRET:=dev-only-change-me}"
: "${DEV_AUTH_ENABLED:=true}"
: "${GATEWAY_PORT:=8080}"; : "${USER_SVC_PORT:=8081}"; : "${CONV_SVC_PORT:=8082}"; : "${AGENT_SVC_PORT:=8000}"
: "${USER_SVC_URL:=http://localhost:8081}"
: "${CONV_SVC_URL:=http://localhost:8082}"
: "${AGENT_SVC_URL:=http://localhost:8000}"
: "${OLLAMA_BASE_URL:=http://localhost:11434/v1}"
export DATABASE_URL REDIS_URL JWT_SECRET DEV_AUTH_ENABLED
export GATEWAY_PORT USER_SVC_PORT CONV_SVC_PORT AGENT_SVC_PORT
export USER_SVC_URL CONV_SVC_URL AGENT_SVC_URL OLLAMA_BASE_URL

# Credential key must be stable across restarts (it decrypts stored keys).
# It goes in .env, which is gitignored. Never a sidecar file in the tree:
# a filename like scripts/.dev_enc_key is one `git add -A` away from
# committing the master key for every user's provider credentials.
if [ -z "${CREDENTIAL_ENC_KEY:-}" ]; then
  [ -f "$ROOT/.env" ] || cp "$ROOT/.env.example" "$ROOT/.env"
  if ! grep -q '^CREDENTIAL_ENC_KEY=.\+' "$ROOT/.env"; then
    echo "generating CREDENTIAL_ENC_KEY into .env ..."
    NEWKEY="$(python -c "import os,base64;print(base64.b64encode(os.urandom(32)).decode())")"
    # replace an empty assignment if present, else append
    if grep -q '^CREDENTIAL_ENC_KEY=' "$ROOT/.env"; then
      python - "$ROOT/.env" "$NEWKEY" <<'PY'
import sys, re, pathlib
p, key = pathlib.Path(sys.argv[1]), sys.argv[2]
p.write_text(re.sub(r'^CREDENTIAL_ENC_KEY=.*$', 'CREDENTIAL_ENC_KEY=' + key, p.read_text(), flags=re.M))
PY
    else
      printf '\nCREDENTIAL_ENC_KEY=%s\n' "$NEWKEY" >> "$ROOT/.env"
    fi
    unset NEWKEY
  fi
  set -a; . "$ROOT/.env"; set +a
fi
if [ -z "${CREDENTIAL_ENC_KEY:-}" ]; then
  echo "FATAL: CREDENTIAL_ENC_KEY is unset and could not be generated." >&2
  exit 1
fi
export CREDENTIAL_ENC_KEY

EXE=""; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) EXE=".exe";; esac

# --- build Go services -------------------------------------------------------
for svc in gateway user-svc conv-svc; do
  echo "building $svc ..."; ( cd "$ROOT/$svc" && go build -o "$svc$EXE" ./... )
done

# --- ensure agent-svc venv ---------------------------------------------------
VENV_PY="$ROOT/agent-svc/.venv/Scripts/python.exe"
[ -f "$VENV_PY" ] || VENV_PY="$ROOT/agent-svc/.venv/bin/python"
if [ ! -f "$VENV_PY" ]; then
  echo "creating agent-svc venv ..."
  python -m venv "$ROOT/agent-svc/.venv"
  "$VENV_PY" -m pip install -q -r "$ROOT/agent-svc/requirements.txt"
fi

# --- ensure web deps ---------------------------------------------------------
if [ -z "${NO_WEB:-}" ] && [ ! -d "$ROOT/web/node_modules" ]; then
  echo "installing web deps ..."; ( cd "$ROOT/web" && pnpm install )
fi

start() { local name="$1"; shift; ( cd "$1" && shift; "$@" >"$LOGS/$name.log" 2>&1 & echo $! >"$LOGS/$name.pid" ); echo "started $name (pid $(cat "$LOGS/$name.pid")) -> logs/$name.log"; }

start conv-svc "$ROOT/conv-svc" "$ROOT/conv-svc/conv-svc$EXE"
start user-svc "$ROOT/user-svc" "$ROOT/user-svc/user-svc$EXE"
start agent-svc "$ROOT/agent-svc/src" "$VENV_PY" -m uvicorn main:app --host 127.0.0.1 --port "$AGENT_SVC_PORT"
start gateway  "$ROOT/gateway" "$ROOT/gateway/gateway$EXE"
[ -z "${NO_WEB:-}" ] && start web "$ROOT/web" pnpm dev

echo ""
echo "agent-svc warms the embedding model at boot (~15-30s)."
echo "Health: curl http://localhost:${GATEWAY_PORT}/healthz   |   E2E: bash scripts/e2e.sh"
