"""rank.py is pure — no DB, no encoder, no fixtures. Stdlib asserts."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from memory import rank


def _rows(*ids, **over):
    return {i: {"id": i, "content": i, "importance": 0.0, **over.get(i, {})} for i in ids}


def test_both_passes_beats_one():
    fts = [{"id": "a"}, {"id": "b"}]
    vec = [{"id": "c"}, {"id": "a"}]
    scores = rank.rrf(fts, vec)
    # 'a' is rank 0 in one pass and rank 1 in the other; 'c' is rank 0 in one.
    assert scores["a"] > scores["c"] > scores["b"]
    out = rank.rerank(_rows("a", "b", "c"), scores, 3)
    assert [r["id"] for r in out] == ["a", "c", "b"]


def test_verified_breaks_a_tie():
    # Identical rank in identical passes -> identical rrf. Only the bonus differs.
    scores = rank.rrf([{"id": "x"}], [{"id": "y"}])
    assert scores["x"] == scores["y"]
    rows = _rows("x", "y", y={"verified": True})
    assert [r["id"] for r in rank.rerank(rows, scores, 2)] == ["y", "x"]


def test_importance_breaks_a_tie():
    scores = rank.rrf([{"id": "x"}], [{"id": "y"}])
    rows = _rows("x", "y", y={"importance": 1.0})
    assert [r["id"] for r in rank.rerank(rows, scores, 2)] == ["y", "x"]


def test_relevance_outweighs_importance():
    # A top-ranked row with zero importance must beat a low-ranked perfect one:
    # 0.7 of the score is relevance, 0.2 is importance. Ordering must reflect it.
    fts = [{"id": "hit"}] + [{"id": f"f{i}"} for i in range(9)] + [{"id": "meh"}]
    vec = [{"id": "hit"}]
    rows = _rows("hit", "meh", meh={"importance": 1.0, "verified": True})
    out = rank.rerank(rows, rank.rrf(fts, vec), 2)
    assert [r["id"] for r in out] == ["hit", "meh"]


def test_empty_pass_and_empty_scores():
    assert rank.rrf([], []) == {}
    assert rank.rerank({}, {}, 5) == []
    # FTS-only (dead encoder) still ranks.
    out = rank.rerank(_rows("a"), rank.rrf([{"id": "a"}], []), 5)
    assert [r["id"] for r in out] == ["a"]


def test_rerank_ignores_ids_without_rows():
    # A scored id we have no row for must not KeyError.
    assert rank.rerank(_rows("a"), {"a": 0.1, "ghost": 9.0}, 5)[0]["id"] == "a"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
    print("ok")
