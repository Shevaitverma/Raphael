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


def test_persist_tags_assistant_with_provenance(monkeypatch):
    # The assistant post carries answered_model + degraded so a reload shows what
    # SSE showed; the user post carries neither (stored null/false).
    posts = []

    class _Resp:
        status_code = 201

        def json(self):
            return {"id": "mid"}

    class _Client:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, params=None, json=None):
            posts.append(json)
            return _Resp()

    monkeypatch.setattr(workflow.httpx, "Client", lambda **k: _Client())
    workflow.persist_node({
        "user_id": "u", "conversation_id": "c", "message": "m",
        "answer": "a", "model": "qwen2.5:7b", "degraded": True,
    })
    user_body, asst_body = posts
    assert "answered_model" not in user_body and not user_body.get("degraded")
    assert asst_body["answered_model"] == "qwen2.5:7b" and asst_body["degraded"] is True


def test_extract_never_reuses_the_credential_that_just_401d(monkeypatch):
    calls = {}
    monkeypatch.setattr(workflow.retriever, "touch", lambda u, ids: calls.setdefault("touch", ids))
    monkeypatch.setattr(workflow.resolver, "extractor", lambda u: calls.setdefault("who", "lifeboat"))
    monkeypatch.setattr(workflow.extractor_mod, "extract", lambda p, m, a: [])
    dead = object()  # state["provider"] on a degraded turn: touching it would raise
    workflow.extract({"user_id": "u", "message": "m one", "answer": "a",
                      "provider": dead, "injected_ids": ["i1"], "degraded": True})
    assert calls == {"touch": ["i1"], "who": "lifeboat"}


def test_extract_skips_the_extractor_on_a_contentless_message(monkeypatch):
    # A message with NO content words (extract._words == {}) can ground nothing,
    # so the extractor is never resolved or called — the free skip-gate win. touch
    # still runs (surfaced memories are still reinforced).
    # extract() swallows every exception, so a raising fake would false-green;
    # record the resolution instead and assert it never happened.
    calls = {}
    monkeypatch.setattr(workflow.retriever, "touch", lambda u, ids: calls.setdefault("touch", ids))
    monkeypatch.setattr(workflow.resolver, "extractor", lambda u: calls.setdefault("resolved", True))
    # "ok" is filtered by the len>2 rule; "2+2" folds to two 1-char tokens; both
    # leave _words == {}. Any of these must skip without resolving the extractor.
    for msg in ("ok", "2+2", "👍"):
        workflow.extract({"user_id": "u", "message": msg, "answer": "a", "injected_ids": []})
    assert calls == {"touch": []}  # touch ran; extractor was never resolved


def test_mutating_task_tool_runs_at_most_once_and_ends_the_loop(monkeypatch):
    # A model that asks to create the SAME task twice (once per round) must write
    # exactly once, and a write must break the refine loop.
    creates = []
    monkeypatch.setattr(workflow.tasks_tool, "create_task",
                        lambda uid, title, notes="", due="": creates.append(title) or f"Added {title}")
    monkeypatch.setattr(workflow.tasks_tool, "looks_task_related", lambda m: True)

    class _Resp:
        tool_calls = [{"name": "create_task", "arguments": {"title": "buy milk"}}]

    class _Caps:
        native_tools = True

    class _Prov:
        provider, model = "local", "m"

        def capabilities(self):
            return _Caps()

        def chat(self, convo, system=None, tools=None, max_tokens=512):
            return _Resp()

    block, tool_calls = workflow._preflight(
        {"user_id": "u", "message": "add buy milk", "provider": _Prov(), "search": False},
        [{"role": "user", "content": "add buy milk"}], "sys",
    )
    assert creates == ["buy milk"]  # exactly one write despite the loop
    assert [c["name"] for c in tool_calls] == ["create_task"]
