# Raphael — Walking Skeleton

One vertical slice that really runs:

```
browser → gateway → agent-svc → resolver → Ollama → streamed reply
                        ↓                              ↓
                    conv-svc                     memories row
                   (Postgres)                  (local embedding)
```

Dev-mode auth, chat persistence, per-user provider resolution, in-process
768-dim embeddings, pgvector retrieval, SSE streaming, and the **lifeboat**
error path (a dead paid credential degrades to the designated fallback
credential; a transient 429 does not).

## Services & ports

| service    | stack            | port | role |
|------------|------------------|------|------|
| gateway    | Go / Fiber       | 8080 | JWT, rate limit, SSE passthrough |
| user-svc   | Go               | 8081 | users + provider_credentials (owns the secrets) |
| conv-svc   | Go               | 8082 | conversations + messages (vendor-neutral) |
| agent-svc  | Python / FastAPI | 8000 | pipeline, resolver, embeddings, memory |
| web        | Next.js          | 3000 | chat UI |
| postgres   | pgvector/pg17    | 5433 | **5433, not 5432** |
| redis      | redis:7          | 6379 | rate-limit counters |

## Prerequisites (fresh machine)

- **Docker** (for Postgres + Redis).
- **Go 1.24+**. On Windows/Git Bash: `export PATH="$PATH:/c/Program Files/Go/bin"`.
- **Python 3.13** with `venv` + `pip` (`uv` not required).
- **Node + pnpm** (only for the `web` UI).
- **Ollama** running at `http://localhost:11434` with at least one chat model
  pulled. `qwen3.5:latest` is preferred; `e2e.sh` auto-selects whatever is
  present. Tool support is **discovered per model**, never assumed from a table —
  a model without it still answers, it just cannot use web search (Tier 2 covers
  it). Note `gemma3:12b` needs ~11 GB free RAM; on a smaller box use
  `ollama pull llama2`.
- If your Ollama runs a `num_ctx` other than the 4096 default, set
  `OLLAMA_NUM_CTX` in `.env` to match it. Under-claiming truncates nothing;
  over-claiming makes Ollama truncate in silence.

## Setup

```bash
cp .env.example .env
# Set a real 32-byte base64 key (used by user-svc to encrypt api keys):
#   openssl rand -base64 32   → paste into CREDENTIAL_ENC_KEY in .env

# Everything in containers:
docker compose up --build     # all services + Postgres, Redis, Ollama (pulls the model on first run)

# …or just infra for host-dev (services on your machine, faster iteration):
docker compose up -d postgres redis
```

There is **one** compose file. `docker compose up` starts the whole stack;
naming a subset (`postgres redis`) starts just those. If your host already runs
Ollama on 11434, set `OLLAMA_HOST_PORT=11435` in `.env`.

The schema (`db/*.sql`) is applied on first container start and seeds the
dev user `00000000-0000-0000-0000-000000000001` with an **active local Ollama
credential**, so the system runs with no paid keys.

## Run all five services (host-dev)

**Windows (PowerShell):**
```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
```

**Git Bash / macOS / Linux:**
```bash
export PATH="$PATH:/c/Program Files/Go/bin"   # Windows only
bash scripts/dev.sh
```

Both scripts build the Go binaries, create the agent-svc venv (first run),
install web deps, and launch everything detached with logs under `./logs/`.
`agent-svc` warms the embedding model at boot (~15–30 s) before `/healthz` goes
green. If `CREDENTIAL_ENC_KEY` is unset they generate and persist a stable dev
key at `scripts/.dev_enc_key`.

`make` shortcuts (Git Bash): `make up` · `make dev` · `make health` · `make e2e`
· `make test` · `make stop` · `make down`.

## Verify

```bash
curl http://localhost:8080/healthz
# {"status":"ok","deps":{"redis":"ok","user_svc":"ok","conv_svc":"ok","agent_svc":"ok"}}

bash scripts/e2e.sh            # full acceptance test, asserts on real output
```

`scripts/e2e.sh` drives the whole path and fails loudly on any deviation:
mint a test JWT → create conversation → chat (asserts tokens stream **incrementally**,
≥1 `token`, exactly one `done`) → checks Postgres (user + assistant messages, a
768-dim `memories` row with `embedding_model`, and **no** provider wire-format)
→ a **search turn** asserting the tool call persists in our neutral shape
(skipped with a loud reason unless `/capabilities` reports both `web_search`
and `native_tools`) → **lifeboat**: activates an invalid `anthropic` key, asserts a `degraded` event
+ a local answer + `is_active` unchanged → **transient**: points an active
provider at a 429 stub and asserts an `error` event with **no** lifeboat → then
restores the local credential as active.

## Manual walkthrough

```bash
# Google Sign-In is the only login endpoint, so there is nothing to curl for a token.
# Grab the access JWT the SPA is holding instead: sign in at localhost:3000, open the
# devtools console and copy it from a request's Authorization header. For scripted runs,
# scripts/e2e.sh mints one locally from JWT_SECRET (see its `mint` helper).
TOKEN=<paste the access JWT>

CID=$(curl -s -X POST localhost:8080/api/conversations -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"title":"hello"}' \
  | python -c 'import sys,json;print(json.load(sys.stdin)["id"])')

curl -N -X POST localhost:8080/api/chat -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"conversation_id\":\"$CID\",\"message\":\"What is the capital of France?\"}"
# event: token ... event: token ... event: done
```

Add a provider key from the UI or the API (`POST /api/providers`
`{provider,auth_type,api_key,base_url?,model_id,activate}`). Keys are encrypted
at rest and never returned by any public route.

## The lifeboat (the contract that matters)

- Active credential **dead** — 401 auth, 403 permission/billing, 402 — the
  request falls back to the credential flagged `is_lifeboat` (local Ollama on a
  laptop, OpenRouter in the cloud), streams a `degraded` SSE event, writes the
  turn under the model that actually answered, and **never** flips `is_active`.
- Active credential hit a **transient** fault — 429, 5xx, timeout, connection —
  the request surfaces an `error` event. No silent downgrade.
- `degraded` means **only** that, and is never used for a web-search failure —
  search is off by default, and when it fails the answer says so in-band rather
  than pretending it was grounded. See `docs/CONTRACT.md`.

## Troubleshooting

- **agent-svc `/healthz` slow to return 200** — it is loading
  `nomic-embed-text-v1.5` at boot. Give it 15–30 s.
- **chat streams nothing / model error** — the active local credential's
  `model_id` must be a model Ollama actually has (`ollama list`). `e2e.sh`
  auto-selects an available one; to set it by hand:
  `UPDATE provider_credentials SET model_id='llama2:latest' WHERE provider='local';`
- **user-svc exits at boot** — `CREDENTIAL_ENC_KEY` is missing or not valid
  base64-of-32-bytes. Regenerate with `openssl rand -base64 32`.
- **port already in use** — `make stop` frees 8080/8081/8082/8000/3000.
- Stop services: `make stop`; stop infra: `make down`.
