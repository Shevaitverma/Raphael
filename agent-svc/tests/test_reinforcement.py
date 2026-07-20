"""Access-driven reinforcement: used memory hardens (the human-memory pattern).

Three DB-shaped guarantees, so this is an integration test that skips when
Postgres is absent (it runs live in the dev stack):

  1. touch() bumps access_count + last_accessed on the rows it recalled — and
     NOT times_seen, which counts re-hearings, a different signal.
  2. reap() spares a dormant-but-recently-accessed row it would otherwise archive.
  3. _IMPORTANCE / _profile rank a higher-access row above an identical one.

Every row it writes is dev-user scratch data, scoped by a unique marker and
deleted in a finally — never a blanket delete of the real account's rows.
"""
import uuid

import psycopg
import pytest

from config import DATABASE_URL
from memory import retriever

DEV_USER = "00000000-0000-0000-0000-000000000001"
ZERO_VEC = "[" + ",".join(["0"] * 768) + "]"


def _conn():
    try:
        return psycopg.connect(DATABASE_URL, connect_timeout=3)
    except Exception:
        pytest.skip("Postgres unavailable")


def _insert_fact(cur, subject, *, access_count=0, last_accessed_days=None):
    rid = str(uuid.uuid4())
    cur.execute(
        """INSERT INTO facts (id, user_id, subject, predicate, object, confidence,
                              times_seen, last_seen, access_count, last_accessed,
                              embedding, embedding_model)
           VALUES (%s, %s, %s, 'likes', 'coffee', 0.9,
                   1, now(), %s,
                   CASE WHEN %s::int IS NULL THEN NULL
                        ELSE now() - make_interval(days => %s::int) END,
                   %s::vector, 'nomic-embed-text')""",
        (rid, DEV_USER, subject, access_count,
         last_accessed_days, last_accessed_days, ZERO_VEC),
    )
    return rid


def _insert_mem(cur, marker, *, days_old, times_seen, last_accessed_days=None):
    rid = str(uuid.uuid4())
    cur.execute(
        """INSERT INTO memories (id, user_id, content, kind, confidence, times_seen,
                                 last_seen, last_accessed, embedding, embedding_model)
           VALUES (%s, %s, %s, 'episodic', 0.9, %s,
                   now() - make_interval(days => %s),
                   CASE WHEN %s::int IS NULL THEN NULL
                        ELSE now() - make_interval(days => %s::int) END,
                   %s::vector, 'nomic-embed-text')""",
        (rid, DEV_USER, marker, times_seen, days_old,
         last_accessed_days, last_accessed_days, ZERO_VEC),
    )
    return rid


def test_touch_reinforces_access_not_rehearing():
    marker = f"reinf-{uuid.uuid4()}"
    conn = _conn()
    try:
        with conn.cursor() as cur:
            fid = _insert_fact(cur, marker)
            conn.commit()

        retriever.touch(DEV_USER, [fid])

        with conn.cursor() as cur:
            cur.execute(
                "SELECT access_count, last_accessed, times_seen FROM facts WHERE id = %s",
                (fid,),
            )
            access_count, last_accessed, times_seen = cur.fetchone()
        assert access_count == 1              # recall hardened it
        assert last_accessed is not None      # and stamped when
        assert times_seen == 1                # but did NOT count it as a re-hearing
    finally:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM facts WHERE user_id = %s AND subject LIKE %s",
                        (DEV_USER, marker + "%"))
        conn.commit()
        conn.close()


def test_reap_spares_recently_accessed_dormant_row():
    marker = f"reinf-reap-{uuid.uuid4()}"
    conn = _conn()
    try:
        with conn.cursor() as cur:
            # Old + never re-heard => reap fodder, EXCEPT it was recalled yesterday.
            used = _insert_mem(cur, marker + "-used", days_old=100, times_seen=1,
                               last_accessed_days=1)
            # Same age, never recalled => genuinely dormant, must be reaped.
            dormant = _insert_mem(cur, marker + "-dormant", days_old=100, times_seen=1,
                                  last_accessed_days=None)
            conn.commit()

        assert retriever.reap() >= 1

        with conn.cursor() as cur:
            cur.execute(
                "SELECT id FROM memories WHERE valid_until IS NULL AND id = ANY(%s::uuid[])",
                ([used, dormant],),
            )
            live = {str(r[0]) for r in cur.fetchall()}
        assert used in live           # used memory is not dormant
        assert dormant not in live    # genuinely dormant still reaped
    finally:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM memories WHERE user_id = %s AND content LIKE %s",
                        (DEV_USER, marker + "%"))
        conn.commit()
        conn.close()


def test_importance_ranks_higher_access_first():
    marker = f"reinf-rank-{uuid.uuid4()}"
    conn = _conn()
    try:
        with conn.cursor() as cur:
            # Identical but for access: the used one must score higher on the exact
            # _IMPORTANCE expression _profile orders by. Scoped to our two ids so the
            # real account's facts (and _profile's LIMIT 8) can't perturb the result.
            hi = _insert_fact(cur, marker + "-hi", access_count=10, last_accessed_days=1)
            lo = _insert_fact(cur, marker + "-lo", access_count=0)
            conn.commit()

        with conn.cursor() as cur:
            cur.execute(
                f"SELECT id, {retriever._IMPORTANCE} AS importance "
                "FROM facts WHERE id = ANY(%s::uuid[])",
                ([hi, lo],),
            )
            imp = {str(r[0]): r[1] for r in cur.fetchall()}
        assert imp[hi] > imp[lo]
    finally:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM facts WHERE user_id = %s AND subject LIKE %s",
                        (DEV_USER, marker + "%"))
        conn.commit()
        conn.close()
