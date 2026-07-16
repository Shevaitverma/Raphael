# Running Raphael locally

Two containers (Postgres, Redis) + five host processes (gateway, user-svc,
conv-svc, agent-svc, web) + Ollama for the local model.

## Prerequisites (one-time)

- Docker Desktop, Go, python3, Node (pnpm optional — scripts fall back to npx)
- Ollama with at least one model: `ollama pull qwen2.5:7b` (it does native tool
  calling, and it's what compose pulls and what `e2e.sh` picks first)
- `.env` in the repo root — created automatically from `.env.example` on first
  `dev.sh` run, which also generates `CREDENTIAL_ENC_KEY` and `INTERNAL_TOKEN`.

## Start

```bash
# 1. infra
docker compose up -d postgres redis

# 2. all five services (builds Go binaries, creates agent-svc venv, installs web deps)
bash scripts/dev.sh

# 3. Ollama, if not already running
ollama serve &   # or just launch the Ollama app
```

agent-svc warms its embedding model at boot — give it ~15–30s.

## Verify

```bash
curl http://localhost:8080/healthz   # gateway    → ok
curl http://localhost:8081/healthz   # user-svc   → ok
curl http://localhost:8082/healthz   # conv-svc   → ok
curl http://localhost:8000/healthz   # agent-svc  → {"status":"ok","deps":{"db":"ok","embeddings":"ok"}}
```

Then open **http://localhost:3000** and dev-login with any email.

Full acceptance test (streaming, persistence, lifeboat, 429 handling):

```bash
bash scripts/e2e.sh
# if your model isn't auto-detected:
LOCAL_MODEL=<name> bash scripts/e2e.sh
```

## Stop

```bash
make stop            # kills the five host processes (via logs/*.pid)
docker compose down  # stops Postgres + Redis (data survives in the pgdata volume)
```

## When something's wrong

- Logs: `tail -f logs/<service>.log` (gateway, user-svc, conv-svc, agent-svc, web)
- Port in use: `lsof -i :8080` (or 8081/8082/8000/3000) and kill the stale pid
- agent-svc dead: almost always the venv — delete `agent-svc/.venv` and rerun `dev.sh`
- "no Ollama model available" from e2e: `ollama list`, then pass `LOCAL_MODEL=<name>`
- Nuke the database (fresh start): `docker compose down -v` — deletes all data

## Fully containerized (deployment-shaped)

```bash
make stop                        # stop host processes first, or ports collide
docker compose up -d --build     # builds and runs the whole stack
```

Nothing to configure: compose runs its own Ollama container and pulls
`qwen2.5:7b` into it, and hardcodes `OLLAMA_BASE_URL=http://ollama:11434/v1`
for agent-svc — the `.env` value applies to host-process mode only. If your host
already runs Ollama on 11434, set `OLLAMA_HOST_PORT=11435` in `.env` so the
container's published port doesn't clash.

First agent-svc image build is slow (installs sentence-transformers).
