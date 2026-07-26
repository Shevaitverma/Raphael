"""agent-svc FastAPI app: /healthz, /capabilities, /chat (SSE)."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import queue
import threading
import time

import psycopg
from fastapi import FastAPI
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

import config
import logsetup
from config import DATABASE_URL
from graph import workflow
from llm import embeddings, resolver
from memory import portrait, read, retriever
from tools import google as google_tool
from tools import search as search_tool

# Application INFO lines (workflow: per-turn tokens, skip-gate, extract) go
# nowhere without a root handler — uvicorn only configures its own loggers. One
# call makes the skip-gate's effect measurable, as workflow.py's comments
# promise, and emits every line as JSON with the same field names as the Go
# services (service/request_id/user_id/...).
logsetup.setup_logging()

app = FastAPI(title="agent-svc")
# One access line per request + the X-Request-Id the gateway stamped on the way in.
app.add_middleware(logsetup.AccessLogMiddleware)

REAP_INTERVAL_SECONDS = 24 * 60 * 60  # daily: bounding growth, not a hot path.


def _reaper_loop() -> None:
    # ponytail: naive fixed-interval thread, not pg_cron. Reap is idempotent, so a
    # double-run under multi-instance is harmless; revisit only if it ever scales out.
    while True:
        retriever.reap()
        _regen_portraits()
        time.sleep(REAP_INTERVAL_SECONDS)


def _regen_portraits() -> None:
    # Daily, after reap: refresh each fact-having user's portrait. synthesize()
    # fingerprint-skips unchanged facts (idle users cost ZERO tokens) and never
    # raises; the per-user guard keeps one bad row from stopping the pass.
    # ponytail: iterate all fact-having users; gate on recent activity only if
    # the user count ever explodes.
    try:
        with psycopg.connect(DATABASE_URL, connect_timeout=5) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT DISTINCT user_id FROM facts")
                user_ids = [row[0] for row in cur.fetchall()]
    except Exception:
        logging.exception("portrait regen: could not list fact-having users")
        return
    for user_id in user_ids:
        try:
            portrait.synthesize(str(user_id))
        except Exception:
            logging.exception("portrait regen failed for user %s", user_id)


@app.on_event("startup")
def _startup() -> None:
    # Fail fast: without these the service boots and then fails on the first
    # chat turn ("no active credential") far away from the actual cause.
    # Raising here aborts uvicorn with a non-zero exit.
    missing = [
        name
        for name, value in (
            ("DATABASE_URL", config.DATABASE_URL),
            ("INTERNAL_TOKEN", config.INTERNAL_TOKEN),
        )
        if not value
    ]
    if missing:
        logging.error(
            "missing required configuration", extra={"fields": {"vars": ",".join(missing)}}
        )
        raise RuntimeError(f"missing required configuration: {','.join(missing)}")

    # ONE line with the resolved critical config, so drift between services is
    # visible at boot instead of costing an afternoon. Secrets are SET/UNSET
    # only, and DATABASE_URL is never printed — it embeds the password.
    logging.info(
        "config",
        extra={
            "fields": {
                "port": os.environ.get("AGENT_SVC_PORT", "8000"),
                "user_svc_url": config.USER_SVC_URL,
                "conv_svc_url": config.CONV_SVC_URL,
                "system_config_uid": config.SYSTEM_CONFIG_UID,
                "embedding_model": config.EMBEDDING_MODEL,
                "ollama_base_url": config.OLLAMA_BASE_URL,
                "openrouter_base_url": config.OPENROUTER_BASE_URL,
                "ollama_num_ctx": config.OLLAMA_NUM_CTX,
                "search_base_url": config.SEARCH_BASE_URL,
                "web_search": search_tool.enabled(),
                "database_url": logsetup.secret_state(config.DATABASE_URL),
                "internal_token": logsetup.secret_state(config.INTERNAL_TOKEN),
                "search_api_key": logsetup.secret_state(config.SEARCH_API_KEY),
            }
        },
    )

    # Warm the encoder at boot, not on the first request.
    embeddings.warm()
    # The write side of the valid_until contract: one pass now, then daily.
    threading.Thread(target=_reaper_loop, daemon=True).start()


@app.get("/health")
def health():
    """The uniform /health every Raphael service answers: same shape, same field
    names, so one loop can check all four. Deliberately cheap — this service owns
    no pool; /healthz is the dependency-aware probe that dials Postgres."""
    return {"service": logsetup.SERVICE, "ok": True}


@app.get("/healthz")
def healthz():
    db = "ok"
    try:
        with psycopg.connect(DATABASE_URL, connect_timeout=3) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
                cur.fetchone()
    except Exception:
        db = "down"
    return {
        "status": "ok",
        "deps": {"db": db, "embeddings": "ok" if embeddings.is_warm() else "cold"},
    }


@app.get("/capabilities")
def capabilities(user_id: str):
    try:
        provider = resolver.chat(user_id)
    except resolver.NoActiveCredential as e:
        return JSONResponse(status_code=409, content={"error": str(e)})
    caps = provider.capabilities().to_dict()
    caps["provider"] = provider.provider
    caps["model"] = provider.model
    # Deployment config, not a model capability — but it is the only bit the UI
    # needs to know whether the search toggle can do anything. A bool; the key
    # itself never leaves the process.
    #
    # search_tool.enabled() rather than reading SEARCH_API_KEY here: "is the tool
    # registered" and "may this toggle light up" must be ONE authority, or the UI
    # eventually promises a tool the workflow never runs. No key -> false, the
    # tool is never offered to a model, and no query leaves the box.
    caps["web_search"] = search_tool.enabled()
    # Per-user, not a global key: does THIS user have a live Google token, so the
    # UI knows whether the calendar tool can do anything. A bool; the token never
    # leaves the process. connected() never raises (degrades to False).
    caps["google_connected"] = google_tool.connected(user_id)
    return caps


@app.get("/memory/graph")
def memory_graph(user_id: str):
    # Query param + read-only DB projection + JSON, exactly like /capabilities.
    # read.graph never raises: a DB hiccup returns the empty-but-valid shape.
    return read.graph(user_id)


@app.get("/memory/stats")
def memory_stats(user_id: str):
    return read.stats(user_id)


@app.get("/memory/portrait")
def memory_portrait(user_id: str):
    # The read-door for the portrait synthesize() writes daily and workflow injects
    # into every system prompt. Pure 0-token read; portrait.get never raises.
    return {"portrait": portrait.get(user_id)}


class ChatBody(BaseModel):
    user_id: str
    conversation_id: str
    message: str
    # Default off IS the privacy posture: absent field -> no query ever leaves.
    search: bool = False
    # Absent -> "Raphael" (back-compat: the e2e and older callers post no name).
    # The gateway resolves the per-user name; workflow sanitizes at point of use.
    assistant_name: str = "Raphael"


@app.post("/chat")
def chat(body: ChatBody):
    # Resolve up front so "no active credential" is a clean 409, not an SSE error.
    try:
        provider = resolver.chat(body.user_id)
    except resolver.NoActiveCredential as e:
        return JSONResponse(status_code=409, content={"error": str(e)})

    q: "queue.Queue" = queue.Queue()

    def emit(event, data):
        q.put((event, data))

    state = {
        "user_id": body.user_id,
        "conversation_id": body.conversation_id,
        "message": body.message,
        "search": body.search,
        "assistant_name": body.assistant_name,
        "provider": provider,
        "emit": emit,
    }

    # A new thread starts with an EMPTY context, so the correlation id has to be
    # carried over by hand — otherwise every workflow log line for the most
    # interesting request in the system (the chat turn) is un-traceable.
    rid = logsetup.request_id_var.get()

    def run():
        logsetup.request_id_var.set(rid)
        try:
            workflow.run(state)
        except Exception as e:  # last-resort guard
            emit("error", {"message": str(e) or type(e).__name__})
        finally:
            q.put(None)  # the stream closes HERE, before any post-done work.
        # Only now is post-done work free. With the sentinel in run()'s finally
        # covering this too, the SSE generator would loop on q.get() until
        # extraction returned — a 3-40s LLM call holding the HTTP response open,
        # and sse_client.py reads to EOF, so the e2e would block on it.
        # Consequence: no SSE event can ever report extraction. There is no
        # reader left. workflow.extract() swallows everything for that reason.
        workflow.extract(state)

    threading.Thread(target=run, daemon=True).start()

    async def sse():
        loop = asyncio.get_event_loop()
        while True:
            item = await loop.run_in_executor(None, q.get)
            if item is None:
                break
            event, data = item
            yield f"event: {event}\ndata: {json.dumps(data)}\n\n"

    return StreamingResponse(sse(), media_type="text/event-stream")
