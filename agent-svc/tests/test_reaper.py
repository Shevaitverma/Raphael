"""retriever.reap() is the write side of the valid_until contract.

The predicates ARE the correctness: it must archive stale, never-reinforced
episodic rows and leave everything else (recent, re-heard, facts) untouched. That
is DB-shaped, so this is an integration test that skips when Postgres is absent
(it runs live in the dev stack). Every row it writes is dev-user scratch data,
scoped by a unique content marker and deleted in a finally.
"""
import uuid

import psycopg
import pytest

from config import DATABASE_URL
from memory import retriever

DEV_USER = "00000000-0000-0000-0000-000000000001"
# A zero vector is a legal 768-dim embedding; reap never looks at it.
ZERO_VEC = "[" + ",".join(["0"] * 768) + "]"


def _conn():
    try:
        return psycopg.connect(DATABASE_URL, connect_timeout=3)
    except Exception:
        pytest.skip("Postgres unavailable")


def _insert(cur, marker, *, days_old, times_seen):
    rid = str(uuid.uuid4())
    cur.execute(
        """INSERT INTO memories (id, user_id, content, kind, confidence, times_seen,
                                 last_seen, embedding, embedding_model)
           VALUES (%s, %s, %s, 'episodic', 0.9, %s,
                   now() - make_interval(days => %s), %s::vector, 'nomic-embed-text')""",
        (rid, DEV_USER, marker, times_seen, days_old, ZERO_VEC),
    )
    return rid


def test_reap_archives_only_stale_unreinforced_episodic_rows():
    marker = f"reaper-test-{uuid.uuid4()}"
    conn = _conn()
    try:
        with conn.cursor() as cur:
            stale = _insert(cur, marker + "-stale", days_old=100, times_seen=1)
            recent = _insert(cur, marker + "-recent", days_old=1, times_seen=1)
            reheard = _insert(cur, marker + "-reheard", days_old=100, times_seen=3)
            conn.commit()

        assert retriever.reap() >= 1

        with conn.cursor() as cur:
            cur.execute(
                "SELECT id FROM memories WHERE valid_until IS NULL AND id = ANY(%s::uuid[])",
                ([stale, recent, reheard],),
            )
            live = {str(r[0]) for r in cur.fetchall()}
        # Old + never re-heard is gone; recent stays; re-heard earned its keep.
        assert stale not in live
        assert recent in live
        assert reheard in live
    finally:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM memories WHERE user_id = %s AND content LIKE %s",
                (DEV_USER, marker + "%"),
            )
        conn.commit()
        conn.close()


def test_reap_never_raises_when_db_is_unreachable(monkeypatch):
    monkeypatch.setattr(retriever, "DATABASE_URL", "postgresql://x@127.0.0.1:1/nope")
    assert retriever.reap() == 0
