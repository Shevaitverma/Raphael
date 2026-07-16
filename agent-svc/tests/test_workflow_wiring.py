"""The wiring, not the modules: the three joins that break silently."""
from graph import workflow


class _P:
    provider, model = "local", "qwen2.5:7b"

    def stream(self, messages, system=None, tools=None, max_tokens=1024):
        _P.seen = (messages, system)
        yield "ok"


def test_generate_appends_the_current_message_after_history():
    # Breaks the day persist_node moves above generate_node: the current message
    # would already be in history and get sent twice.
    state = {
        "user_id": "u", "message": "now", "emit": lambda e, d: None, "provider": _P(),
        "history": [{"role": "user", "content": "before"}, {"role": "assistant", "content": "hi"}],
    }
    workflow.generate_node(state)
    assert [m["content"] for m in _P.seen[0]] == ["before", "hi", "now"]


def test_system_ranks_the_live_turn_over_retrieval_and_never_claims_relevance():
    s = workflow.build_system(["works at Acme"], ["likes brevity"])
    assert "now" in s.lower() and "Relevant" not in s
    assert s.index("Acme") < s.index("brevity")  # stable prefix first
    assert workflow.build_system([], []) == workflow.SYSTEM_BASE


def test_persist_never_fabricates_the_fk(monkeypatch):
    # conv-svc down: message_id may be a local uuid, the FK must be None.
    monkeypatch.setattr(workflow.httpx, "Client", lambda **k: 1 / 0)
    out = workflow.persist_node({"user_id": "u", "conversation_id": "c", "message": "m"})
    assert out["message_id"] and out["persisted_message_id"] is None


def test_extract_never_reuses_the_credential_that_just_401d(monkeypatch):
    calls = {}
    monkeypatch.setattr(workflow.retriever, "touch", lambda u, ids: calls.setdefault("touch", ids))
    monkeypatch.setattr(workflow.resolver, "extractor", lambda u: calls.setdefault("who", "lifeboat"))
    monkeypatch.setattr(workflow.extractor_mod, "extract", lambda p, m, a: [])
    dead = object()  # state["provider"] on a degraded turn: touching it would raise
    workflow.extract({"user_id": "u", "message": "m", "answer": "a",
                      "provider": dead, "injected_ids": ["i1"], "degraded": True})
    assert calls == {"touch": ["i1"], "who": "lifeboat"}
