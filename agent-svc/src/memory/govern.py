"""The forget door: delete one fact or one note, scoped to its owner.

Not in read.py — that module's contract is read-only AND never-raises, and the
second half is actively wrong here: swallowing a DB error into a 404 would tell
the user "that memory is already gone" while the row lives on and keeps being
injected into tomorrow's prompt. Three outcomes, kept distinct: deleted (True),
absent-for-this-user (False), broken (raises -> 500).

The only line that matters is the WHERE: BOTH id and user_id, always. id alone
is a cross-user data-loss hole — and because a row owned by someone else matches
zero rows, "not yours" and "not there" are indistinguishable from the outside,
which is the point.

Deleting the row is only half the forget. `user_portraits.portrait` is a cached
prose sketch synthesized from facts+notes and injected into EVERY system prompt
(workflow.build_system), so a surviving portrait keeps asserting the belief the
user just struck out — the feature would visibly not work. So a successful
delete drops the portrait row too, in the SAME transaction: next synthesize()
rebuilds it from the survivors, and until then get() returns None and the model
simply reads no card. No portrait beats a portrait stating a removed belief.

Invalidate, never re-synthesize here: synthesis is an LLM call and this is the
0-token REST door. Nor is bumping fact_fingerprint enough — that only makes the
DAILY regen recompute, leaving the wrong sentence in every prompt until then,
and synthesize() early-returns on a now-empty fact set, stranding it forever.
"""
from __future__ import annotations

import psycopg

from config import DATABASE_URL


def delete(table: str, row_id: str, user_id: str) -> bool:
    """Delete one row + invalidate the user's portrait. True if the row existed
    and belonged to user_id, else False (then nothing is invalidated).

    `table` is a module-level literal at every call site, never request input —
    same discipline as retriever._bump. One statement, not select-then-delete: a
    check-then-act is both a race and the easiest place for a later refactor to
    drop the user_id predicate.

    Both statements share one connection and one implicit transaction, so they
    cannot diverge: psycopg's context manager commits only on a clean exit, and
    a failed invalidation rolls the delete back with it (the caller gets a 500,
    the fact stays, the portrait stays — consistent either way).
    """
    with psycopg.connect(DATABASE_URL, connect_timeout=5) as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"DELETE FROM {table} WHERE id = %s AND user_id = %s",
                (row_id, user_id),
            )
            if cur.rowcount != 1:
                return False  # 404: nothing was forgotten, so nothing is stale.
            cur.execute("DELETE FROM user_portraits WHERE user_id = %s", (user_id,))
            return True


def demo() -> None:
    """A delete must invalidate the owner's portrait — and ONLY the owner's.

    Runs against the live DB on two throwaway @raphael.test users it creates and
    drops. Touches no other row: every statement here is keyed to those two ids.
    """
    import uuid

    a, b = str(uuid.uuid4()), str(uuid.uuid4())
    zeros = "[" + ",".join(["0"] * 768) + "]"
    with psycopg.connect(DATABASE_URL, connect_timeout=5) as conn:
        try:
            with conn.cursor() as cur:
                for u in (a, b):
                    cur.execute(
                        "INSERT INTO users (id, email, name) VALUES (%s, %s, 'throwaway')",
                        (u, f"{u}@raphael.test"),
                    )
                    cur.execute(
                        "INSERT INTO facts (user_id, subject, predicate, object,"
                        " embedding, embedding_model) VALUES (%s, 'you', 'cooks',"
                        " 'north indian dishes', %s, 'demo')",
                        (u, zeros),
                    )
                    cur.execute(
                        "INSERT INTO user_portraits (user_id, portrait) VALUES (%s,"
                        " 'You cook north indian dishes.')",
                        (u,),
                    )
                cur.execute("SELECT id FROM facts WHERE user_id = %s", (a,))
                fact_id = str(cur.fetchone()[0])
            conn.commit()

            def portrait_rows(u: str) -> int:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT count(*) FROM user_portraits WHERE user_id = %s", (u,)
                    )
                    return cur.fetchone()[0]

            # Wrong owner -> no delete, and B's portrait must survive untouched.
            assert delete("facts", fact_id, b) is False
            assert portrait_rows(a) == 1 and portrait_rows(b) == 1
            # A missing id is a 404, not an excuse to wipe a good portrait.
            assert delete("facts", str(uuid.uuid4()), a) is False
            assert portrait_rows(a) == 1
            # The real thing: A's fact goes, A's stale portrait goes with it...
            assert delete("facts", fact_id, a) is True
            assert portrait_rows(a) == 0
            # ...and B, who deleted nothing, still has hers.
            assert portrait_rows(b) == 1
            print("govern.demo OK")
        finally:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM users WHERE id = ANY(%s)", ([a, b],))
            conn.commit()


if __name__ == "__main__":
    demo()
