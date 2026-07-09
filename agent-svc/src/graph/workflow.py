"""The linear LangGraph: retrieve -> generate -> persist -> remember.

- retrieve: local query embedding + pgvector top-k, budgeted to the active
  provider's window.
- generate: stream tokens, with the lifeboat wrapped around a dead credential.
- persist: neutral messages -> conv-svc (:8082).
- remember: embed + write memories to Postgres.

The graph emits SSE events through a plain callable (`emit`) carried in state,
so main.py can drain them to the client in real time.
"""
from __future__ import annotations

import uuid
from typing import Any, TypedDict

import httpx
from langgraph.graph import END, StateGraph

from config import CONV_SVC_URL
from llm import resolver
from memory import retriever

SYSTEM_BASE = "You are Raphael, a helpful personal assistant. Answer concisely."


def build_system(context) -> str:
    if not context:
        return SYSTEM_BASE
    mem = "\n".join(f"- {c}" for c in context)
    return SYSTEM_BASE + "\n\nRelevant memories about the user:\n" + mem


def stream_with_lifeboat(user_id, provider, messages, system, emit, lifeboat_fn=None) -> dict:
    """Stream from the active provider; fall back to the lifeboat ONLY on a
    dead credential. On a transient fault, emit an 'error' event and stop.

    The lifeboat NEVER flips is_active — there is deliberately no such call in
    this module. The user's configuration stays theirs; we only answer, once,
    visibly degraded.
    """
    lifeboat_fn = lifeboat_fn or (lambda: resolver.lifeboat(user_id))
    result = {
        "answer": "",
        "model": provider.model,
        "provider_name": provider.provider,
        "degraded": False,
        "failed": False,
    }
    parts: list[str] = []
    try:
        for chunk in provider.stream(messages, system=system):
            if chunk:
                parts.append(chunk)
                emit("token", {"text": chunk})
        result["answer"] = "".join(parts)
        return result
    except Exception as e:
        if not resolver.is_dead_credential(e):
            # 429 / 5xx / timeout / connection error -> propagate as 'error'.
            emit("error", {"message": str(e) or type(e).__name__})
            result["failed"] = True
            return result

        lb = lifeboat_fn()
        if lb is None:
            emit(
                "error",
                {"message": "The active credential was rejected and no local lifeboat is configured."},
            )
            result["failed"] = True
            return result

        # Fire the lifeboat: announce the degrade, then answer on the local row.
        emit("degraded", {"reason": "credential rejected", "provider": lb.provider, "model": lb.model})
        parts = []
        try:
            for chunk in lb.stream(messages, system=system):
                if chunk:
                    parts.append(chunk)
                    emit("token", {"text": chunk})
        except Exception as e2:
            emit("error", {"message": f"Lifeboat provider failed: {e2!s}"})
            result["failed"] = True
            return result
        result["answer"] = "".join(parts)
        result["degraded"] = True
        result["model"] = lb.model
        result["provider_name"] = lb.provider
        return result


class GState(TypedDict, total=False):
    user_id: str
    conversation_id: str
    message: str
    emit: Any
    provider: Any
    context: list
    answer: str
    model: str
    provider_name: str
    degraded: bool
    failed: bool
    message_id: str


def retrieve_node(state: GState) -> dict:
    caps = state["provider"].capabilities()
    ctx = retriever.retrieve(state["user_id"], state["message"], caps.max_context_tokens)
    return {"context": ctx}


def generate_node(state: GState) -> dict:
    system = build_system(state.get("context") or [])
    messages = [{"role": "user", "content": state["message"]}]
    return stream_with_lifeboat(state["user_id"], state["provider"], messages, system, state["emit"])


def _post_message(client, conversation_id, role, content):
    return client.post(
        f"{CONV_SVC_URL}/conversations/{conversation_id}/messages",
        json={"role": role, "content": content},
    )


def persist_node(state: GState) -> dict:
    if state.get("failed"):
        return {}
    mid = None
    try:
        with httpx.Client(timeout=10.0) as client:
            _post_message(client, state["conversation_id"], "user", state["message"])
            r = _post_message(client, state["conversation_id"], "assistant", state.get("answer", ""))
            if r.status_code < 300:
                data = r.json()
                mid = data.get("id") or data.get("message_id")
    except Exception:
        mid = None
    # Fall back to a local id so the turn still completes if conv-svc is down.
    return {"message_id": mid or str(uuid.uuid4())}


def remember_node(state: GState) -> dict:
    if state.get("failed"):
        return {}
    try:
        retriever.remember(state["user_id"], [state["message"], state.get("answer", "")])
    except Exception:
        pass
    state["emit"](
        "done",
        {
            "provider": state.get("provider_name"),
            "model": state.get("model"),
            "message_id": state.get("message_id"),
        },
    )
    return {}


def _build_graph():
    g = StateGraph(GState)
    g.add_node("retrieve", retrieve_node)
    g.add_node("generate", generate_node)
    g.add_node("persist", persist_node)
    g.add_node("remember", remember_node)
    g.set_entry_point("retrieve")
    g.add_edge("retrieve", "generate")
    g.add_edge("generate", "persist")
    g.add_edge("persist", "remember")
    g.add_edge("remember", END)
    return g.compile()


_GRAPH = None


def run(state: dict) -> None:
    global _GRAPH
    if _GRAPH is None:
        _GRAPH = _build_graph()
    _GRAPH.invoke(state)
