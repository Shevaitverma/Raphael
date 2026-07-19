"""Read-only projections of a user's memory for the graph view and dashboard.

Mirrors retriever.py's connection discipline: one psycopg connection off
DATABASE_URL, every query scoped WHERE user_id=%s, the embedding column NEVER in
a SELECT list, and — like retrieve() — never raises into the request. A DB
hiccup degrades to an empty-but-valid shape, not a 500.

This is a pure projection: no writes, no decay math, no encoder. The workflow
owns what memory means; here we only render what is already stored.
"""
from __future__ import annotations

import psycopg
from psycopg.rows import dict_row

from config import DATABASE_URL

GRAPH_LIMIT = 200  # rowcount == LIMIT is how we know the graph was truncated.
NOTES_LIMIT = 50
TOP_FACTS_LIMIT = 5


def _iso(ts):
    return ts.isoformat() if ts is not None else None


def graph(user_id: str) -> dict:
    """Facts as a node/edge graph + recent episodic notes.

    Each distinct subject_n / object_n is one node (id = the normalized value,
    label = the first raw text seen for it). Every fact row is one edge. The
    highest-degree node is tagged identity — on a personal graph that is the
    user's own name, so we keep its real text rather than inventing a "You".
    """
    empty = {"nodes": [], "edges": [], "notes": [], "truncated": False}
    try:
        with psycopg.connect(DATABASE_URL, connect_timeout=5) as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(
                    """SELECT subject, subject_n, predicate, object, object_n,
                              confidence, times_seen, first_seen, last_seen
                         FROM facts
                        WHERE user_id = %s
                        ORDER BY times_seen DESC
                        LIMIT %s""",
                    (user_id, GRAPH_LIMIT),
                )
                rows = cur.fetchall()
                truncated = cur.rowcount == GRAPH_LIMIT

                cur.execute(
                    """SELECT id, content, confidence, last_seen
                         FROM memories
                        WHERE user_id = %s
                          AND kind = 'episodic'
                          AND valid_until IS NULL
                        ORDER BY last_seen DESC
                        LIMIT %s""",
                    (user_id, NOTES_LIMIT),
                )
                note_rows = cur.fetchall()
    except Exception:
        return empty

    labels: dict[str, str] = {}  # id -> first raw text seen
    degree: dict[str, int] = {}
    edges = []
    for r in rows:
        s, o = r["subject_n"], r["object_n"]
        labels.setdefault(s, r["subject"])
        labels.setdefault(o, r["object"])
        degree[s] = degree.get(s, 0) + 1
        degree[o] = degree.get(o, 0) + 1
        edges.append(
            {
                "source": s,
                "target": o,
                "label": r["predicate"],
                "confidence": r["confidence"],
                "times_seen": r["times_seen"],
                "first_seen": _iso(r["first_seen"]),
                "last_seen": _iso(r["last_seen"]),
            }
        )

    identity = max(degree, key=degree.get) if degree else None
    nodes = [
        {
            "id": nid,
            "label": labels[nid],
            "kind": "identity" if nid == identity else "entity",
            "degree": degree[nid],
        }
        for nid in labels
    ]

    notes = [
        {
            "id": str(n["id"]),
            "content": n["content"],
            "confidence": n["confidence"],
            "last_seen": _iso(n["last_seen"]),
        }
        for n in note_rows
    ]
    return {"nodes": nodes, "edges": edges, "notes": notes, "truncated": truncated}


def stats(user_id: str) -> dict:
    """Dashboard counters: totals, the most-reinforced facts, 14-day activity."""
    empty = {
        "facts": 0,
        "episodic": 0,
        "conversations": 0,
        "top_facts": [],
        "activity": [],
        "truncated": False,
    }
    try:
        with psycopg.connect(DATABASE_URL, connect_timeout=5) as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute("SELECT count(*) AS n FROM facts WHERE user_id = %s", (user_id,))
                facts = cur.fetchone()["n"]

                cur.execute(
                    """SELECT count(*) AS n FROM memories
                        WHERE user_id = %s AND kind = 'episodic' AND valid_until IS NULL""",
                    (user_id,),
                )
                episodic = cur.fetchone()["n"]

                cur.execute(
                    "SELECT count(*) AS n FROM conversations WHERE user_id = %s", (user_id,)
                )
                conversations = cur.fetchone()["n"]

                cur.execute(
                    """SELECT subject, predicate, object, confidence, times_seen, last_seen
                         FROM facts
                        WHERE user_id = %s
                        ORDER BY times_seen DESC
                        LIMIT %s""",
                    (user_id, TOP_FACTS_LIMIT),
                )
                top_facts = [
                    {
                        "subject": r["subject"],
                        "predicate": r["predicate"],
                        "object": r["object"],
                        "confidence": r["confidence"],
                        "times_seen": r["times_seen"],
                        "last_seen": _iso(r["last_seen"]),
                    }
                    for r in cur.fetchall()
                ]

                cur.execute(
                    """SELECT to_char(date_trunc('day', first_seen), 'YYYY-MM-DD') AS d,
                              count(*) AS n
                         FROM facts
                        WHERE user_id = %s
                          AND first_seen > now() - interval '14 days'
                        GROUP BY d
                        ORDER BY d""",
                    (user_id,),
                )
                activity = [{"day": r["d"], "count": r["n"]} for r in cur.fetchall()]
    except Exception:
        return empty

    return {
        "facts": facts,
        "episodic": episodic,
        "conversations": conversations,
        "top_facts": top_facts,
        "activity": activity,
        "truncated": False,
    }
