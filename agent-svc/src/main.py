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
    return caps


class ChatBody(BaseModel):
    user_id: str
    conversation_id: str
    message: str


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
        "provider": provider,
        "emit": emit,
    }

    def run():
        try:
            workflow.run(state)
        except Exception as e:  # last-resort guard
            emit("error", {"message": str(e) or type(e).__name__})
        finally:
            q.put(None)

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
