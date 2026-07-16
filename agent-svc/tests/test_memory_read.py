"""Short-term memory reads. Fully offline — no DB, no conv-svc, no network.

Four things here break SILENTLY. A model given no history does not error, it
just answers worse; a provider handed a leading assistant turn or two user
turns in a row 400s in a way that reads like a provider outage. Nothing else in
the product notices, so it gets asserted here.
"""
import httpx

from memory import history, retriever
from memory.budget import budgets, est_tokens

# Shape copied from conv-svc/handlers.go:168 — a BARE ARRAY of these, ASC.
def _row(role, content, i=0):
    return {
        "id": f"00000000-0000-0000-0000-{i:012d}",
        "conversation_id": "c1",
        "role": role,
        "content": content,
        "created_at": "2026-07-16T00:00:00Z",
    }


def _stub(monkeypatch, payload=None, status=200, exc=None, capture=None):
    def fake_get(url, **kw):
        if capture is not None:
            capture.update(kw.get("params") or {})
            capture["timeout"] = kw.get("timeout")
        if exc:
            raise exc
        return httpx.Response(status, json=payload, request=httpx.Request("GET", url))

    monkeypatch.setattr(history.httpx, "get", fake_get)


# --- budgets scale with the window -------------------------------------------

def test_budget_scales_with_the_window():
    """THE bug retriever.py:28 has today: `min(window // 4, 4000)` gives a 1M
    window and a 16k window the identical budget. A bigger model must buy more
    room, or paying for one buys nothing."""
    assert budgets(4096)[2] < budgets(1_000_000)[2]
    assert budgets(8192)[2] < budgets(200_000)[2]


def test_budget_is_a_fraction_of_the_window_not_a_flat_cap():
    for w in (8192, 32_000, 128_000):
        assert budgets(w)[2] == int(max(384, min(w // 3, 24_000)) * 0.60)


def test_budget_splits_profile_memories_history():
    p, m, h = budgets(72_000)
    assert (p, m, h) == (3600, 6000, 14400)  # 24k total, 0.15 / 0.25 / 0.60
    assert p + m + h <= 24_000
    assert h > m > p  # history is the biggest share


def test_tiny_window_still_gets_a_floor():
    """A tiny local model must still get *some* history — that is the defect.
    512 // 3 is 170, below the 384 floor, so the floor is what answers."""
    p, m, h = budgets(512)
    assert h > 0 and m > 0 and p > 0
    assert p + m + h <= 384
    assert budgets(512) == budgets(1)  # the floor, not a scaled-to-nothing budget


def test_huge_window_is_capped():
    assert budgets(10_000_000) == budgets(1_000_000)


def test_est_tokens_never_zero():
    assert est_tokens("") == 1  # a zero cost would make the trim loop keep it free
    assert est_tokens("a" * 400) == 100


# --- normalize: what providers reject ----------------------------------------

def test_normalize_drops_leading_assistant():
    """Anthropic wants the first message to be user."""
    out = history.normalize([_row("assistant", "hi"), _row("user", "hello")])
    assert out == [{"role": "user", "content": "hello"}]


def test_normalize_drops_tool_turns():
    """DB roles are user|assistant|tool; the wire accepts only user|assistant."""
    out = history.normalize(
        [_row("user", "a"), _row("tool", '{"result": 1}'), _row("assistant", "b")]
    )
    assert [m["role"] for m in out] == ["user", "assistant"]
    assert all(m["role"] != "tool" for m in out)


def test_normalize_drops_empty_content():
    """A failed turn persists an empty assistant row (workflow.py:142)."""
    out = history.normalize([_row("user", "a"), _row("assistant", ""), _row("user", "b")])
    assert out == [{"role": "user", "content": "a\n\nb"}]


def test_normalize_collapses_same_role_runs():
    """persist_node returns early on failure (workflow.py:129,135), so two user
    messages in a row are REAL history, not corruption. Collapse, don't drop."""
    out = history.normalize([_row("user", "a"), _row("user", "b"), _row("assistant", "c")])
    assert [m["role"] for m in out] == ["user", "assistant"]
    assert out[0]["content"] == "a\n\nb"


def test_normalize_output_alternates():
    rows = [_row("user", "a"), _row("assistant", "b"), _row("assistant", "c"), _row("user", "d")]
    out = history.normalize(rows)
    assert [m["role"] for m in out] == ["user", "assistant", "user"]


def test_normalize_only_emits_role_and_content():
    out = history.normalize([_row("user", "a")])
    assert set(out[0]) == {"role", "content"}  # no id/created_at on the wire


def test_normalize_survives_garbage_rows():
    out = history.normalize(["nope", None, 42, {}, {"role": "user"}, _row("user", "a")])
    assert out == [{"role": "user", "content": "a"}]


# --- fetch: trims from the oldest end ----------------------------------------

def test_fetch_trims_from_the_oldest_end(monkeypatch):
    """Recency is what the defect needs: 'what did I just say?' lives in the
    LAST turn. Trimming from the newest end would pass a budget assertion and
    still fail the only question that matters."""
    rows = [_row("user", "old " * 25, 1), _row("assistant", "mid " * 25, 2), _row("user", "new", 3)]
    _stub(monkeypatch, payload=rows)

    kept, dropped = history.fetch("c1", 30, "u1")

    assert kept[-1]["content"] == "new"
    assert "old" not in "".join(m["content"] for m in kept)
    assert dropped and "old" in dropped[0]["content"]


def test_fetch_keeps_everything_under_budget(monkeypatch):
    rows = [_row("user", "a", 1), _row("assistant", "b", 2), _row("user", "c", 3)]
    _stub(monkeypatch, payload=rows)

    kept, dropped = history.fetch("c1", 10_000, "u1")

    assert [m["content"] for m in kept] == ["a", "b", "c"]
    assert dropped == []


def test_fetch_renormalizes_after_the_slice(monkeypatch):
    """The trim can strand a leading assistant turn. Re-normalize or the
    provider 400s on a history that was valid before we cut it."""
    rows = [_row("user", "x " * 40, 1), _row("assistant", "answer", 2), _row("user", "q", 3)]
    _stub(monkeypatch, payload=rows)

    kept, dropped = history.fetch("c1", 6, "u1")

    assert kept and kept[0]["role"] == "user"
    assert len(dropped) + len(kept) == 3


def test_fetch_sends_user_id_and_limit_and_a_short_timeout(monkeypatch):
    """user_id is required (conv-svc 404s on a mismatch); the timeout is 3.0s,
    NOT the 10.0s persist uses — this runs before the first token."""
    seen = {}
    _stub(monkeypatch, payload=[], capture=seen)

    history.fetch("c1", 1200, "u1")

    assert seen["user_id"] == "u1"
    assert 1 <= seen["limit"] <= 500  # conv-svc caps at 500 (handlers.go:307)
    assert seen["timeout"] == 3.0


# --- fetch: never breaks a turn ----------------------------------------------

def test_fetch_survives_conv_svc_being_down(monkeypatch):
    for exc in (httpx.ConnectError("refused"), httpx.ReadTimeout("slow"), ValueError("bad json")):
        _stub(monkeypatch, exc=exc)
        assert history.fetch("c1", 1000, "u1") == ([], [])


def test_fetch_survives_an_error_status(monkeypatch):
    for status in (400, 404, 500):
        _stub(monkeypatch, payload={"error": "nope"}, status=status)
        assert history.fetch("c1", 1000, "u1") == ([], [])


def test_fetch_guards_a_non_list_body(monkeypatch):
    """conv-svc returns a BARE ARRAY. An object means the contract moved —
    .get() on a list would raise straight into the turn."""
    for payload in ({"messages": []}, "nope", 42, None):
        _stub(monkeypatch, payload=payload)
        assert history.fetch("c1", 1000, "u1") == ([], [])


# --- the profile pass must read a table that can hold rows -------------------

class _Cur:
    """The two cursor methods _profile touches. No DB: this asserts the SHAPE of
    the query, which is where the defect lived."""
    def __init__(self, rows):
        self.rows, self.sql = rows, ""

    def execute(self, sql, params=None):
        self.sql = sql

    def fetchall(self):
        return self.rows


def test_profile_reads_facts_not_an_impossible_memories_kind():
    """THE defect: _profile filtered memories WHERE kind IN ('fact','preference'),
    but memories_kind_check permits only ('raw','episodic') — the predicate was
    unsatisfiable, so the pass returned [] for every user on every turn and
    workflow.py:54's "What we believe about the user:" block could never render.
    Widening the CHECK would not have fixed it either: no writer produces those
    kinds (write_notes hardcodes 'episodic', write_facts targets `facts`). The
    table was the bug, so `facts` is the fix — and this is also the only reader
    `facts` has ever had."""
    cur = _Cur([{"id": "f1", "content": "user lives in Berlin"}])

    assert retriever._profile(cur, "u1") == [{"id": "f1", "content": "user lives in Berlin"}]
    assert "FROM facts" in cur.sql
    assert "kind" not in cur.sql  # any kind filter here is unsatisfiable by construction
    assert "valid_until" not in cur.sql  # facts has no tombstone column to filter on
