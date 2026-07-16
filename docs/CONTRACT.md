# Build Contract — Walking Skeleton

Binding for every service. If you are an agent building one service, obey this literally.
Anything not specified here is yours to decide inside your own directory.

## Milestone

**A walking skeleton, not Week 1.** One vertical slice that really runs:

```
browser → gateway → agent-svc → resolver → Ollama → streamed reply
                        ↓                              ↓
                    conv-svc                     memories row
                   (Postgres)                  (local embedding)
```

**In scope:** dev-mode auth, chat persistence, provider resolution, local in-process
embeddings, pgvector retrieval, SSE streaming, the lifeboat error path.
**Out of scope (stub or omit):** background workers, subagents, branching beyond a
linear pipeline.

**Tool-calling was out of scope and is no longer.** This document said "stub or omit"
and web search reversed it: a grounded answer needs the model to choose the query, and
that needs one tool call. Scoped narrowly — ONE pre-flight `chat()` call carrying one
tool, then the normal stream. There is no streaming tool loop, `stream()` is untouched,
and `stream_with_lifeboat()` is still called exactly once per turn.

## Layout — one directory per service. Never write outside yours.

```
gateway/    Go 1.24+  :8080   Fiber, JWT, rate limit, SSE passthrough
user-svc/   Go 1.24+  :8081   users + provider_credentials (owns the secrets)
conv-svc/   Go 1.24+  :8082   conversations + messages
agent-svc/  Python    :8000   FastAPI, llm/ adapters, memory
web/        Next.js   :3000   chat UI
db/         (exists)          001_init.sql, 002_lifeboat.sql — already applied. Do not edit.
```

## Environment

Read `.env.example`. Never read `.env`. Never print a secret value.
Postgres is on **5433** (5432 is taken by an unrelated container).
Python is **3.13** (not 3.12 — adjust any pin). `uv` is not installed; use `pip` + `venv`.

## Auth (dev mode)

`POST /auth/dev-login {"email": "dev@raphael.local"}` → `{"token": "...", "user": {...}}`
JWT HS256, secret `JWT_SECRET`, claims `{"sub": "<user uuid>", "exp": ...}`.
Every `/api/*` route requires `Authorization: Bearer <token>`.
The seeded dev user is `00000000-0000-0000-0000-000000000001`.

## The neutral message shape — NEVER store a provider's wire format

```json
{ "role": "user|assistant|tool",
  "content": "text",
  "tool_calls": [ { "name": "...", "arguments": { } } ] }
```

No `toolu_…`/`call_…` ids. No thinking blocks. No `cache_control`. Adapters translate
to and from their vendor's shape; that shape never leaves the adapter.

## Capabilities

```json
{ "max_context_tokens": 131072, "native_tools": true, "streaming": true, "json_schema": true }
```

Illustrative, **not** a table to code against. This section used to pin a fixed window and
a per-model tools flag; both were fiction, and asserting that table is the exact bug
`test_capabilities.py` exists to stop.

**Capability is a property of the MODEL, not the provider — never hardcode a table.**
OpenRouter serves both 8k Llamas and 1M Geminis under one provider, so a per-provider
constant is a lie by construction. Capabilities are DISCOVERED per model and under-claimed
when unknown — over-claiming makes the server truncate in silence.
`OLLAMA_NUM_CTX` is the calibration knob for the local served window; set it to the
`num_ctx` your Ollama really runs.

Memory retrieval budgets against `max_context_tokens` of the **active** provider, computed
per request, never at boot.

---

## gateway/  (Go, :8080)

| method | path | notes |
|---|---|---|
| GET | `/healthz` | `{"status":"ok","deps":{"redis":"ok","user_svc":"ok","conv_svc":"ok","agent_svc":"ok"}}` |
| POST | `/auth/dev-login` | only when `DEV_AUTH_ENABLED=true` |
| GET | `/api/conversations` | proxy → conv-svc, `user_id` from JWT |
| POST | `/api/conversations` | proxy → conv-svc |
| GET | `/api/conversations/:id/messages` | proxy → conv-svc |
| POST | `/api/chat` | `{"conversation_id":"…","message":"…","search":false}` → **SSE passthrough** from agent-svc |
| GET | `/api/providers` | proxy → user-svc. **Never returns a key.** |
| POST | `/api/providers` | proxy → user-svc |

Rate limit 60 req/min/user via Redis. Never call `/internal/*` on user-svc from a public route.
CORS allow-list from `CORS_ORIGINS` (comma-separated, default `http://localhost:3000`).

## user-svc/  (Go, :8081) — owns the secrets

Encrypt `api_key_enc` with AES-256-GCM using base64 `CREDENTIAL_ENC_KEY`. It is **never**
returned by a public route.

| method | path | notes |
|---|---|---|
| GET | `/healthz` | |
| GET | `/users/{uid}/credentials` | list. **No key field.** |
| POST | `/users/{uid}/credentials` | `{provider,auth_type,api_key?,base_url?,model_id,activate}` |
| POST | `/users/{uid}/credentials/{id}/activate` | flips `is_active`; DB enforces one active |
| GET | `/internal/users/{uid}/credential/active` | **internal only** → `{provider,auth_type,api_key,base_url,model_id}` decrypted |
| GET | `/internal/users/{uid}/credential/lifeboat` | the row flagged `is_lifeboat` (and not active), or `204` |

`auth_type='oauth'` is only valid with `provider='anthropic'` (the DB rejects otherwise).

## conv-svc/  (Go, :8082)

| method | path |
|---|---|
| GET | `/healthz` |
| POST | `/conversations` `{user_id,title?}` |
| GET | `/conversations?user_id=` |
| GET | `/conversations/{id}/messages` |
| POST | `/conversations/{id}/messages` `{role,content,tool_calls?}` |

## agent-svc/  (Python 3.13, :8000)

```
src/
  main.py            FastAPI
  graph/workflow.py  linear pipeline: context → generate → persist → done.
                     Extraction is NOT a node: main.py calls extract() AFTER the
                     SSE stream closes, so no SSE event can ever report it.
  llm/base.py        ChatProvider / EmbeddingProvider protocols + Capabilities
  llm/anthropic_api.py   anthropic SDK, messages.create
  llm/anthropic_cli.py   claude-agent-sdk via OAuth token, completion-only (native_tools: false)
  llm/openai_compat.py   openai SDK, base_url → Ollama or OpenRouter
  llm/embeddings.py      sentence-transformers, in-process, 768d
  llm/resolver.py        chat(user) / embed() / lifeboat(user)
  memory/retriever.py    embed query → pgvector cosine top-k
```

| method | path | notes |
|---|---|---|
| GET | `/healthz` | |
| GET | `/capabilities?user_id=` | discovered per model, plus `web_search` — a key is configured **and** the tool is wired |
| POST | `/chat` `{user_id,conversation_id,message,search?}` | → SSE. `search` defaults to false; an absent field means no query ever leaves |

**SSE events** (`text/event-stream`):

```
event: token     data: {"text":"He"}
event: degraded  data: {"reason":"credential rejected","provider":"local","model":"qwen3.5:latest"}
event: done      data: {"provider":"local","model":"qwen3.5:latest","message_id":"…"}
event: error     data: {"message":"…"}
```

**Resolution.** `resolver.chat(user)` reads the ONE active credential via user-svc
`/internal/.../active`. Selection has no precedence. Map:
`anthropic+api_key → anthropic_api` · `anthropic+oauth → anthropic_cli` ·
`openai_compat → openai_compat(OpenRouter)` · `local → openai_compat(Ollama)`.
No active row → `409` with a message telling the user to add a key.

**The lifeboat.** On a *dead credential only* — `401 authentication_error`,
`403 permission_error`, `403 billing_error`, `402` — fetch
`/internal/.../lifeboat`; if present, re-run on it, emit a `degraded` SSE event, and
record the answering model. **Never** on `429`, `5xx`, timeout, or connection error —
those propagate as an `error` event. The lifeboat never flips `is_active`.

**Web search.** Default OFF: no `BRAVE_API_KEY` → the tool is never registered and the
model is never told it could search. The search key is deployment config, **not** a
`provider_credentials` row — it has no model, cannot stream, and must never be a
lifeboat. Only a query string ever leaves the box; never the conversation, history,
memories, or profile. Snippets only — no URL from a result is ever dereferenced, which
is why there is no SSRF allowlist to get wrong.

Two tiers, one injection point (a fenced block appended last by `build_system`, then a
normal stream). Tier 1 = native tools: one pre-flight `chat()` picks the query. Tier 2 =
no native tools (`anthropic+oauth` structurally, per `max_turns=1`): the toggle is the
gate and the user's raw message is the query — more data leaving, which the toggle label
says out loud. The tier is never announced; **both tiers ground and cite**, so a silent
Tier 1 → Tier 2 demotion still yields a grounded, cited answer.

**`degraded` is NOT used for search failure. Ever.** It means one thing — a dead
credential fell back to the lifeboat — and search failure is not that. The chat brain is
fine; a rejected *search* key (401) is not credential death, never touches `is_active`,
and never fires the lifeboat. The pre-flight call emits **neither `degraded` nor
`error`** — it can only add an in-band notice. That rule is what keeps `n_degraded == 1`
on the lifeboat path and `n_error == 0` true by construction.

| failure | Tier 1 | Tier 2 |
|---|---|---|
| no key | tool never registered; no notice, no egress | toggle disabled; no notice |
| search 429/5xx/timeout | notice, ungrounded, no citations | notice, ungrounded |
| zero results | notice, ungrounded | notice, ungrounded |
| search key rejected (401) | log, disable for the process, notice. No `degraded` | same |
| model declines the tool | no notice — it judged search unnecessary | n/a |
| malformed tool call | one retry, then notice + ungrounded. Never fabricate a citation | n/a |
| pre-flight hits a DEAD chat credential | skip search silently; the stream fires exactly one `degraded` as always | n/a |
| pre-flight hits a TRANSIENT fault | skip search, notice, stream normally | n/a |

The notice, verbatim, as ordinary `token` events: `(Live search was requested but
unavailable — this answer is from training data and may be out of date.)`

**Citations are in-band `token` events — no fifth SSE event.** After the stream returns,
agent-svc appends a sources block built from the URLs it actually fetched and persists it
with the answer, so **a citation URL cannot be fabricated**. Snippets never enter
`content` (they live in the system prompt and die with the turn); only title + URL do.
Sources present ⇔ real fetched sources. Notice present ⇔ search was wanted and did not
happen. There is no third state where a hallucinated answer looks grounded.

**Embeddings.** In-process only. `sentence-transformers` loading
`nomic-ai/nomic-embed-text-v1.5`, 768 dims, CPU. Warm the model at startup, not on the
first request. Write `memories.embedding_model` on every row. Never ask a chat provider
to embed — Claude has no embeddings endpoint.

## web/  (Next.js, :3000)

App Router + TypeScript + Tailwind. One page: dev-login, conversation list, message
thread, composer. Consume `/api/chat` SSE with `EventSource`-style parsing (`fetch` +
`ReadableStream`, since we send an `Authorization` header). Render the `degraded` event
as a visible banner on the message — that is a product requirement, not decoration.

## Definition of done, per service

- It compiles / imports.
- `GET /healthz` returns 200.
- Its own tests pass (`go test ./...` / `pytest`).
- It does not read `.env`, print secrets, or write outside its directory.
