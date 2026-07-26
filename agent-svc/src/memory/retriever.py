"""Hybrid memory retrieval and writing over Postgres.

retrieve(): two passes over `memories` — Postgres FTS and pgvector cosine —
fused with RRF, plus a query-independent profile pass over `facts`, each
budgeted in tokens against the ACTIVE provider's window (passed in per request,
never read at boot). One connection, three queries.

Both retrieval passes read only LIVE rows (valid_until IS NULL). The vector pass
additionally pins embedding_model: the column is fixed at 768 dims, so a vector
from a different encoder is silently comparable and silently wrong. This is the
read side of the guarantee that column exists for.

If the encoder is dead the vector pass is skipped and retrieval degrades to
FTS-only. Recall drops; memory lives.

write_facts()/write_notes(): distilled knowledge only. There is deliberately no
remember() for raw turns — the transcript already lives in conv-svc, and copying
it here was the unbounded-growth bug.
"""
from __future__ import annotations

import os

import psycopg
from psycopg.rows import dict_row

from config import DATABASE_URL
from llm import resolver
from memory import rank

# Cosine distance above which a row is NOT relevant, however well it ranked —
# top-k always fills, so without a floor a barely-related row gets injected as
# "Relevant" and the model believes us.
# ponytail: starting guess, NOT derived. Tune against ~200 real turns.
MEMORY_DIST_FLOOR = float(os.environ.get("MEMORY_DIST_FLOOR", "0.55"))

# Notes closer than this to a live note are the same note.
NOTE_DEDUP_DIST = 0.15

# Episodic rows this old and never re-heard (times_seen <= 1) are archived by the
# reaper. ponytail: fixed threshold, tune against real retention like the floor.
REAP_AFTER_DAYS = int(os.environ.get("MEMORY_REAP_AFTER_DAYS", "90"))

# Computed, never stored: a stored importance is stale the moment the clock
# moves and needs a recompute cron to stay honest. ::float8 keeps exp() off
# numeric, where a very old row is an expensive way to reach zero.
#
# Two orthogonal signals: times_seen/last_seen = how often the WORLD re-asserted
# the memory (re-hearings, write side); access_count/last_accessed = how often WE
# reached for it (recall, touch side). Used memory hardens even if never re-heard,
# so both frequency terms and both recency terms carry weight. last_accessed is
# NULL until first recall — a never-used row simply scores 0 on those two terms.
_IMPORTANCE = """(
      0.25 * confidence
    + 0.20 * LEAST(1.0, times_seen / 5.0)
    + 0.15 * LEAST(1.0, access_count / 5.0)
    + 0.25 * exp(-EXTRACT(epoch FROM (now() - last_seen))::float8 / (60 * 86400))
    + 0.15 * CASE WHEN last_accessed IS NULL THEN 0.0
                  ELSE exp(-EXTRACT(epoch FROM (now() - last_accessed))::float8 / (60 * 86400))
             END
)"""


def _vec_literal(vec) -> str:
    # pgvector accepts a text literal cast to ::vector — avoids a driver dep.
    return "[" + ",".join(f"{float(x):.6f}" for x in vec) + "]"


def _embed(texts, prefix: str):
    """None if the encoder is unavailable. Retrieval survives that; it must not
    take the turn down with it.
    """
    try:
        enc = resolver.embed()
        return enc, enc.embed(texts, prefix=prefix)
    except Exception:
        return None, None


def _fts(cur, user_id: str, query: str, limit: int) -> list[dict]:
    # A stopword-only query yields an empty tsquery matching nothing. That is a
    # correct empty pass, not an error — RRF handles it.
    cur.execute(
        f"""SELECT id, content, {_IMPORTANCE} AS importance
              FROM memories
             WHERE user_id = %(uid)s
               AND valid_until IS NULL
               AND confidence >= 0.2
               AND to_tsvector('english', content) @@ plainto_tsquery('english', %(q)s)
             ORDER BY ts_rank(to_tsvector('english', content),
                              plainto_tsquery('english', %(q)s)) DESC
             LIMIT %(lim)s""",
        {"uid": user_id, "q": query, "lim": limit},
    )
    return cur.fetchall()


def _vector(cur, user_id: str, qvec, model: str, limit: int) -> list[dict]:
    """Two-stage: HNSW can only order by distance, so take the top 50 by pure
    cosine (index-accelerated) and re-rank those in the select list. The floor is
    applied in Python, not in the WHERE clause — a predicate on the distance
    expression fights HNSW's ordered scan.
    """
    cur.execute(
        f"""SELECT id, content, {_IMPORTANCE} AS importance,
                   embedding <=> %(vec)s::vector AS dist
              FROM memories
             WHERE user_id = %(uid)s
               AND valid_until IS NULL
               AND confidence >= 0.2
               AND embedding_model = %(model)s
             ORDER BY embedding <=> %(vec)s::vector
             LIMIT 50""",  # ponytail: 50 rows to return 5. Materialise importance if it hits a slow-query log.
        {"uid": user_id, "vec": _vec_literal(qvec), "model": model},
    )
    rows = [r for r in cur.fetchall() if r["dist"] <= MEMORY_DIST_FLOOR]
    return rows[:limit]


def _profile(cur, user_id: str) -> list[dict]:
    """Query-independent. Powers the turns whose message carries no retrievable
    signal ("recommend me something"). confidence >= 0.5, stricter than the 0.2
    retrieval floor: a fact injected unconditionally should be one we believe.

    Reads `facts`, and is its ONLY reader. It used to read memories WHERE kind IN
    ('fact','preference') — unsatisfiable against memories_kind_check, which
    permits only ('raw','episodic'), so the pass returned [] on every turn
    forever. Widening the CHECK would not have revived it either: nothing writes
    those kinds. write_facts() routes every triple here, so this is where the
    profile actually lives.

    No valid_until clause: facts has no tombstone. A triple is superseded by the
    facts_triple_unique upsert, not archived, so there is nothing to filter.
    """
    cur.execute(
        f"""SELECT id, subject || ' ' || predicate || ' ' || object AS content
              FROM facts
             WHERE user_id = %(uid)s
               AND confidence >= 0.5
             ORDER BY {_IMPORTANCE} DESC
             LIMIT 8""",
        {"uid": user_id},
    )
    return cur.fetchall()


def _fit(rows: list[dict], budget_tokens: int) -> list[dict]:
    out: list[dict] = []
    used = 0
    for row in rows:
        est = max(1, len(row["content"]) // 4)  # ponytail: ~4 chars/token.
        if used + est > budget_tokens:
            break
        out.append(row)
        used += est
    return out


def retrieve(user_id: str, query: str, mem_budget: int, prof_budget: int, k: int = 5) -> dict:
    """{"memories": [...], "profile": [...], "injected_ids": [...]}.

    Never raises: an empty context must not break a turn.
    """
    out: dict = {"memories": [], "profile": [], "injected_ids": []}
    enc, qvecs = _embed([query], "search_query: ")

    try:
        with psycopg.connect(DATABASE_URL, connect_timeout=5) as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                fts = _fts(cur, user_id, query, k * 2)
                vec = _vector(cur, user_id, qvecs[0], enc.model_name, k * 2) if qvecs else []
                prof = _profile(cur, user_id)
    except Exception:
        return out

    rows = {r["id"]: r for r in (*fts, *vec)}
    ranked = _fit(rank.rerank(rows, rank.rrf(fts, vec), k), mem_budget)
    prof = _fit(prof, prof_budget)

    out["memories"] = [r["content"] for r in ranked]
    out["profile"] = [r["content"] for r in prof]
    out["injected_ids"] = list({r["id"]: None for r in (*ranked, *prof)})
    return out


def _bump(cur, table: str, user_id: str, ids, source_message_id=None) -> None:
    # Re-hearing: the world re-asserted this memory (a note dedup-hit, a fact
    # upsert). `table` is a module-level literal at every call site, never input.
    #
    # A re-hearing is also the second chance to record provenance: the row the
    # dedup hit may have been written while conv-svc was down (NULL). COALESCE,
    # never overwrite — this turn's id may itself be NULL, and a plain assignment
    # would erase good provenance on the next degraded turn.
    cur.execute(
        f"UPDATE {table} SET times_seen = times_seen + 1, last_seen = now(), "
        "source_message_id = COALESCE(source_message_id, %s::uuid) "
        "WHERE id = ANY(%s::uuid[]) AND user_id = %s",
        (source_message_id, [str(i) for i in ids], user_id),
    )


def _reinforce(cur, table: str, user_id: str, ids) -> None:
    # Access-driven reinforcement: WE recalled this row. Deliberately NOT
    # times_seen — recall is not a re-hearing. This is the signal reap() shields
    # and _IMPORTANCE ranks by, so used memory hardens on its own axis.
    cur.execute(
        f"UPDATE {table} SET access_count = access_count + 1, last_accessed = now() "
        "WHERE id = ANY(%s::uuid[]) AND user_id = %s",
        ([str(i) for i in ids], user_id),
    )


def touch(user_id: str, ids) -> None:
    """Reinforce the rows we just recalled — the human-memory pattern: use hardens.

    Runs post-stream (off the critical path). Bumps access_count + last_accessed,
    NOT times_seen: recall is us reaching for a memory, a different signal from the
    world re-asserting it. That access recency is what _IMPORTANCE ranks by and
    what reap() shields from archival.

    injected_ids mixes memories ids (retrieval) and facts ids (profile). A uuid
    lives in exactly one of the two tables, so reinforcing both with the whole
    list is one extra statement instead of threading id provenance out of
    retrieve(). The user_id clause is defence in depth: the ids came from our own
    query, but scoping the write to the owner costs nothing.
    """
    if not ids:
        return
    try:
        with psycopg.connect(DATABASE_URL, connect_timeout=5) as conn:
            with conn.cursor() as cur:
                _reinforce(cur, "memories", user_id, ids)
                _reinforce(cur, "facts", user_id, ids)
    except Exception:
        pass


def reap() -> int:
    """Archive stale, never-reinforced episodic memories. Returns rows archived.

    The missing WRITE side of the valid_until contract. The read path already
    filters `valid_until IS NULL` and the HNSW index is partial on it, but nothing
    ever SET it — so episodic rows (and the index) grew without bound and a
    long-idle memory was still retrieved live. Setting the tombstone drops the row
    from retrieval and from the partial index in one statement.

    Scope is deliberate: kind='episodic' only (facts are superseded via upsert,
    never archived) and times_seen <= 1 (a re-heard memory earned its keep). A row
    recalled within the window is also spared even at times_seen <= 1 — used memory
    is not dormant, the whole point of access-driven reinforcement. Never raises; a
    failed reap is a no-op, not a downed turn.
    """
    try:
        with psycopg.connect(DATABASE_URL, connect_timeout=5) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """UPDATE memories SET valid_until = now()
                        WHERE valid_until IS NULL
                          AND kind = 'episodic'
                          AND times_seen <= 1
                          AND last_seen < now() - make_interval(days => %s)
                          AND (last_accessed IS NULL
                               OR last_accessed < now() - make_interval(days => %s))""",
                    (REAP_AFTER_DAYS, REAP_AFTER_DAYS),
                )
                return cur.rowcount
    except Exception:
        return 0


def _clamp(c) -> float:
    try:
        c = float(c)
    except (TypeError, ValueError):
        return 0.7
    return min(1.0, max(0.01, c))  # CHECK (confidence > 0 AND confidence <= 1)


def write_facts(user_id: str, triples: list[dict], source_message_id) -> int:
    """Upsert triples. ON CONFLICT is race-safe and IS the dedup — there is no
    SELECT-then-INSERT window to lose. The constraint is named, not inferred:
    inference over generated columns is ambiguous.

    Fields that violate the table's length CHECKs are dropped, not truncated. A
    CHECK violation aborts the whole transaction and loses every other fact in
    the batch; truncating invents data the model never said.
    """
    rows = [
        t
        for t in triples or []
        if 1 <= len((t.get("subject") or "").strip()) <= 120
        and 1 <= len((t.get("predicate") or "").strip()) <= 80
        and 1 <= len((t.get("object") or "").strip()) <= 300
    ]
    if not rows:
        return 0
    texts = [f"{t['subject']} {t['predicate']} {t['object']}" for t in rows]
    enc, vecs = _embed(texts, "search_document: ")
    if not vecs:
        return 0

    try:
        with psycopg.connect(DATABASE_URL, connect_timeout=5) as conn:
            with conn.cursor() as cur:
                cur.executemany(
                    """INSERT INTO facts (user_id, subject, predicate, object, confidence,
                                          embedding, embedding_model, source_message_id)
                       VALUES (%s, %s, %s, %s, %s, %s::vector, %s, %s)
                       ON CONFLICT ON CONSTRAINT facts_triple_unique DO UPDATE SET
                           times_seen = facts.times_seen + 1,
                           last_seen  = now(),
                           confidence = LEAST(1.0, GREATEST(facts.confidence,
                                                            EXCLUDED.confidence) + 0.02),
                           -- ON CONFLICT is the common path for a returning user,
                           -- so without this a fact first heard while conv-svc was
                           -- down stays NULL forever. COALESCE, not assignment:
                           -- EXCLUDED is NULL on a degraded turn and would wipe it.
                           source_message_id = COALESCE(facts.source_message_id,
                                                        EXCLUDED.source_message_id)""",
                    [
                        (
                            user_id,
                            t["subject"].strip(),
                            t["predicate"].strip(),
                            t["object"].strip(),
                            _clamp(t.get("confidence")),
                            _vec_literal(v),
                            enc.model_name,
                            source_message_id,
                        )
                        for t, v in zip(rows, vecs)
                    ],
                )
    except Exception:
        return 0
    return len(rows)


def write_notes(user_id: str, notes: list[dict], source_message_id) -> int:
    """Insert episodic notes, skipping near-duplicates of live notes.

    Cosine dedup is safe here and would not be for facts: a note is a full
    sentence with enough signal to separate, a three-word triple is not.
    Re-hearing a note bumps its decay signal rather than adding a second row.
    """
    items = [n for n in notes or [] if (n.get("content") or "").strip()]
    if not items:
        return 0
    enc, vecs = _embed([n["content"].strip() for n in items], "search_document: ")
    if not vecs:
        return 0

    written = 0
    try:
        with psycopg.connect(DATABASE_URL, connect_timeout=5) as conn:
            with conn.cursor() as cur:
                for note, vec in zip(items, vecs):
                    lit = _vec_literal(vec)
                    cur.execute(
                        """SELECT id, embedding <=> %(vec)s::vector AS dist
                             FROM memories
                            WHERE user_id = %(uid)s
                              AND valid_until IS NULL
                              AND kind = 'episodic'
                              AND embedding_model = %(model)s
                            ORDER BY embedding <=> %(vec)s::vector
                            LIMIT 1""",
                        {"uid": user_id, "vec": lit, "model": enc.model_name},
                    )
                    hit = cur.fetchone()
                    if hit and hit[1] < NOTE_DEDUP_DIST:
                        _bump(cur, "memories", user_id, [hit[0]], source_message_id)
                        continue
                    cur.execute(
                        """INSERT INTO memories (user_id, content, kind, confidence,
                                                 embedding, embedding_model, source_message_id)
                           VALUES (%s, %s, 'episodic', %s, %s::vector, %s, %s)""",
                        (
                            user_id,
                            note["content"].strip(),
                            _clamp(note.get("confidence")),
                            lit,
                            enc.model_name,
                            source_message_id,
                        ),
                    )
                    written += 1
    except Exception:
        return written
    return written
