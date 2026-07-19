"""agent-svc FastAPI app: /healthz, /capabilities, /chat (SSE)."""
from __future__ import annotations

import asyncio
import json
import queue
import threading

import psycopg
from fastapi import FastAPI
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from config import DATABASE_URL
from graph import workflow
from llm import embeddings, resolver
from tools import google as google_tool
from tools import search as search_tool

app = FastAPI(title="agent-svc")


@app.on_event("startup")
def _startup() -> None:
    # Warm the encoder at boot, not on the first request.
    embeddings.warm()


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

    def run():
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
