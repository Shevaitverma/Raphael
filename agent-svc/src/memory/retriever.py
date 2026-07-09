"""Memory retrieval and writing over pgvector.

retrieve(): embed the query locally, cosine top-k over `memories` via pgvector
(<=>), and budget the retrieved context against the ACTIVE provider's
max_context_tokens (passed in per request, never read at boot).

remember(): embed content locally and INSERT rows, always recording
embedding_model next to the vector.
"""
from __future__ import annotations

import psycopg

from config import DATABASE_URL
from llm import resolver


def _vec_literal(vec) -> str:
    # pgvector accepts a text literal cast to ::vector — avoids a driver dep.
    return "[" + ",".join(f"{float(x):.6f}" for x in vec) + "]"


def retrieve(user_id: str, query: str, max_context_tokens: int, k: int = 5) -> list[str]:
    enc = resolver.embed()
    qvec = enc.embed([query])[0]
    # Budget context against the active provider's window (~4 chars/token),
    # capped so a 1M Claude window never dumps everything into a local model.
    budget = max(256, min(max_context_tokens // 4, 4000))

    rows: list[str] = []
    try:
        with psycopg.connect(DATABASE_URL, connect_timeout=5) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT content FROM memories WHERE user_id=%s "
                    "ORDER BY embedding <=> %s::vector LIMIT %s",
                    (user_id, _vec_literal(qvec), k),
                )
                rows = [r[0] for r in cur.fetchall()]
    except Exception:
        # Retrieval is best-effort; an empty context must not break a turn.
        return []

    out: list[str] = []
    used = 0
    for content in rows:
        est = max(1, len(content) // 4)
        if used + est > budget:
            break
        out.append(content)
        used += est
    return out


def remember(user_id: str, contents) -> None:
    enc = resolver.embed()
    items = [c for c in contents if c and c.strip()]
    if not items:
        return
    vecs = enc.embed(items)
    try:
        with psycopg.connect(DATABASE_URL, connect_timeout=5) as conn:
            with conn.cursor() as cur:
                for content, vec in zip(items, vecs):
                    cur.execute(
                        "INSERT INTO memories (user_id, content, embedding, embedding_model) "
                        "VALUES (%s, %s, %s::vector, %s)",
                        (user_id, content, _vec_literal(vec), enc.model_name),
                    )
            conn.commit()
    except Exception:
        # Best-effort; do not let a memory write break the response.
        pass
