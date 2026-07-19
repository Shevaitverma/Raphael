"""memory.read is a read-only projection of facts/memories for the graph + stats.

The node/edge shaping, the identity tagging (highest-degree node), and the
truncation flag ARE the logic, so this is an integration test against the live
dev Postgres (skips when it is absent, like test_reaper.py). Every row it writes
belongs to a throwaway user with a random uuid, deleted in a finally — one
user, so the FK CASCADE from users takes facts/memories/conversations with it.

Fails against pre-change code: memory/read.py does not exist.
"""
import uuid

import psycopg
import pytest

from config import DATABASE_URL
from memory import read

ZERO_VEC = "[" + ",".join(["0"] * 768) + "]"  # a legal 768-dim embedding; read never selects it


def _conn():
    try:
        return psycopg.connect(DATABASE_URL, connect_timeout=3)
    except Exception:
        pytest.skip("Postgres unavailable")


def _fact(cur, uid, subject, predicate, obj, times_seen):
    cur.execute(
        """INSERT INTO facts (user_id, subject, predicate, object, confidence, times_seen,
                              embedding, embedding_model)
           VALUES (%s, %s, %s, %s, 0.9, %s, %s::vector, 'nomic-embed-text')""",
        (uid, subject, predicate, obj, times_seen, ZERO_VEC),
    )


def test_graph_and_stats():
    uid = str(uuid.uuid4())
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO users (id, email, name) VALUES (%s, %s, 'Throwaway')",
                (uid, f"read-test-{uid}@example.test"),
            )
            # Sheva is the subject of every edge -> degree 3, the identity node.
            _fact(cur, uid, "Sheva", "likes", "Coffee", 5)
            _fact(cur, uid, "Sheva", "works at", "Acme", 3)
            _fact(cur, uid, "Sheva", "lives in", "Pune", 2)
            cur.execute(
                """INSERT INTO memories (user_id, content, kind, confidence, embedding, embedding_model)
                   VALUES (%s, 'Sheva shipped the graph view', 'episodic', 0.7, %s::vector, 'nomic-embed-text')""",
                (uid, ZERO_VEC),
            )
            cur.execute("INSERT INTO conversations (user_id, title) VALUES (%s, 'chat')", (uid,))
            conn.commit()

        # ---- graph ----
        g = read.graph(uid)
        assert len(g["edges"]) == 3
        assert len(g["nodes"]) == 4  # sheva, coffee, acme, pune
        by_id = {n["id"]: n for n in g["nodes"]}
        # id is the normalized value, label is the raw text.
        assert by_id["sheva"]["label"] == "Sheva"
        assert by_id["sheva"]["kind"] == "identity"
        assert by_id["sheva"]["degree"] == 3
        assert by_id["coffee"]["kind"] == "entity"
        # edges are times_seen DESC; embedding never surfaces.
        assert g["edges"][0]["label"] == "likes"
        assert g["edges"][0]["times_seen"] == 5
        assert isinstance(g["edges"][0]["first_seen"], str)
        assert g["truncated"] is False
        assert len(g["notes"]) == 1
        assert g["notes"][0]["content"] == "Sheva shipped the graph view"

        # ---- truncation: rowcount == LIMIT ----
        orig = read.GRAPH_LIMIT
        read.GRAPH_LIMIT = 2
        try:
            assert read.graph(uid)["truncated"] is True
        finally:
            read.GRAPH_LIMIT = orig

        # ---- stats ----
        s = read.stats(uid)
        assert s["facts"] == 3
        assert s["episodic"] == 1
        assert s["conversations"] == 1
        assert len(s["top_facts"]) == 3
        assert s["top_facts"][0]["object"] == "Coffee"  # highest times_seen
        assert sum(a["count"] for a in s["activity"]) == 3  # all inserted just now
    finally:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM users WHERE id = %s", (uid,))
        conn.commit()
        conn.close()


def test_read_never_raises_when_db_is_unreachable(monkeypatch):
    monkeypatch.setattr(read, "DATABASE_URL", "postgresql://x@127.0.0.1:1/nope")
    assert read.graph("00000000-0000-0000-0000-000000000000") == {
        "nodes": [], "edges": [], "notes": [], "truncated": False
    }
    assert read.stats("00000000-0000-0000-0000-000000000000")["facts"] == 0
