"""Fusion and re-ranking — the pure, testable half of retrieval.

No DB, no network, no I/O: everything here is a function of the rows the passes
returned. Reciprocal Rank Fusion because it needs no score calibration — ts_rank
and cosine distance are not on the same scale and never will be, so we fuse the
ORDER, not the numbers.
"""
from __future__ import annotations

RRF_K = 60


def rrf(*passes: list[dict]) -> dict:
    """id -> fused score. A row found by two passes beats a row found by one,
    which is the entire point of running two passes.
    """
    scores: dict = {}
    for rows in passes:
        for i, row in enumerate(rows):
            scores[row["id"]] = scores.get(row["id"], 0.0) + 1.0 / (RRF_K + i + 1)
    return scores


def rerank(rows: dict, scores: dict, k: int) -> list[dict]:
    """Top-k rows by fused rank and importance.

    rows: id -> row dict. scores: id -> rrf score. Relevance dominates (0.7);
    importance breaks near-ties (0.2).
    """
    if not scores:
        return []
    top = max(scores.values()) or 1.0

    def score(i) -> float:
        row = rows[i]
        return (
            (scores[i] / top) * 0.7
            + float(row.get("importance") or 0.0) * 0.2
        )

    ids = sorted((i for i in scores if i in rows), key=score, reverse=True)
    return [rows[i] for i in ids[:k]]
