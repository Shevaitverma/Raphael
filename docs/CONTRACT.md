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
**Out of scope (stub or omit):** tools/tool-calling, background workers, subagents,
branching beyond a linear pipeline.

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
{ "max_context_tokens": 32768, "native_tools": true, "streaming": true, "json_schema": true }
```

`qwen2.5:7b` → `native_tools: true`. `gemma3:12b` → `native_tools: false`.
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
| POST | `/api/chat` | `{"conversation_id":"…","message":"…"}` → **SSE passthrough** from agent-svc |
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
  graph/workflow.py  linear pipeline: retrieve → generate → persist → remember
  llm/base.py        ChatProvider / EmbeddingProvider protocols + Capabilities
  llm/anthropic_api.py   anthropic SDK, messages.create
  llm/anthropic_cli.py   claude-agent-sdk via OAuth token, completion-only (native_tools: false)
  llm/openai_compat.py   openai SDK, base_url → Ollama or OpenRouter
  llm/embeddings.py      sentence-transformers, in-process, 768d
  llm/resolver.py        chat(user) / embed() / lifeboat(user)
  memory/retriever.py    embed query → pgvector cosine top-k
```

| method | path |
|---|---|
| GET | `/healthz` |
| GET | `/capabilities?user_id=` |
| POST | `/chat` `{user_id,conversation_id,message}` → SSE |

**SSE events** (`text/event-stream`):

```
event: token     data: {"text":"He"}
event: degraded  data: {"reason":"credential rejected","provider":"local","model":"qwen2.5:7b"}
event: done      data: {"provider":"local","model":"qwen2.5:7b","message_id":"…"}
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
