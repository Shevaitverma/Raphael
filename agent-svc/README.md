# agent-svc

Python 3.13 / FastAPI, port 8000. The heart of Raphael: provider resolution,
in-process embeddings, pgvector retrieval, a linear pipeline, SSE streaming,
and the lifeboat error path.

## Layout

```
src/
  main.py             FastAPI: /healthz, /capabilities, /chat (SSE)
  config.py           env-derived constants (never reads .env)
  graph/workflow.py   linear pipeline: retrieve -> generate -> persist -> remember
  llm/base.py         ChatProvider / EmbeddingProvider protocols + Capabilities
  llm/anthropic_api.py    anthropic SDK, messages.create/.stream
  llm/anthropic_cli.py    claude-agent-sdk subprocess, oauth (no api key)
  llm/openai_compat.py    openai SDK, base_url -> Ollama or OpenRouter
  llm/embeddings.py       sentence-transformers, in-process, 768d, warmed at boot
  llm/resolver.py         chat(user) / embed() / lifeboat(user) + dead-credential test
  memory/retriever.py     embed query -> pgvector cosine top-k, budgeted
tests/                  pytest
```

## Run

```
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt
.venv/Scripts/python -m uvicorn main:app --app-dir src --host 0.0.0.0 --port 8000
```

Endpoints:
- `GET  /healthz`
- `GET  /capabilities?user_id=<uuid>`
- `POST /chat` `{user_id, conversation_id, message}` -> `text/event-stream`
  emitting `token` / `degraded` / `done` / `error` events.

## Test

```
.venv/Scripts/python -m pytest
```

Dependencies (already running, do not re-create): Postgres on 5433, Ollama on
11434. The embedding model (`nomic-ai/nomic-embed-text-v1.5`) downloads once at
first warm.
