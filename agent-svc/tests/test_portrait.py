"""The user-portrait card: synthesis is token-min, sanitized, and best-effort.

_sanitize is a pure trust-boundary function and always runs. The rest are DB
integration tests that skip when Postgres is absent (they run live in the dev
stack), asserting:

  1. A free extractor returning prose => get() returns the SANITIZED portrait,
     control chars stripped and length capped (system-prompt trust boundary).
  2. Fingerprint UNCHANGED => synthesize makes NO LLM call (token-min): the fake
     extractor's chat is never invoked on the second, facts-unchanged run.
  3. No free credential (extractor -> None) => no write, no raise (degrade silent).

DATA SAFETY: every test mints its OWN throwaway user (random uuid + unique email)
and deletes ONLY that user in a finally (ON DELETE CASCADE clears its facts and
portrait). It never reads, writes, or deletes DEV_UID's rows — no blanket deletes.
"""
import uuid

import psycopg
import pytest

from config import DATABASE_URL
from memory import portrait

ZERO_VEC = "[" + ",".join(["0"] * 768) + "]"


class FakeResponse:
    def __init__(self, text):
        self.text = text


class FakeProvider:
    """Not an OpenAICompatProvider, so synthesize passes no reasoning kwarg — it
    still must accept whatever it is handed. Counts calls so an unchanged
    fingerprint can be proven to skip the LLM."""

    def __init__(self, text):
        self._text = text
        self.calls = 0

    def chat(self, messages, system=None, max_tokens=1024, **extra):
        self.calls += 1
        return FakeResponse(self._text)


def _conn():
    try:
        conn = psycopg.connect(DATABASE_URL, connect_timeout=3)
    except Exception:
        pytest.skip("Postgres unavailable")
    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass('user_portraits')")
        if cur.fetchone()[0] is None:
            conn.close()
            pytest.skip("migration 012 (user_portraits) not applied")
    return conn


def _make_user(cur, *, with_facts=True):
    uid = str(uuid.uuid4())
    cur.execute(
        "INSERT INTO users (id, email, name) VALUES (%s, %s, 'Portrait Test')",
        (uid, f"portrait-test-{uid}@raphael.test"),
    )
    if with_facts:
        for pred, obj in (("works in", "AI research"), ("prefers", "short direct answers")):
            cur.execute(
                """INSERT INTO facts (user_id, subject, predicate, object, confidence,
                                      embedding, embedding_model)
                   VALUES (%s, 'user', %s, %s, 0.9, %s::vector, 'nomic-embed-text')""",
                (uid, pred, obj, ZERO_VEC),
            )
    return uid


def test_sanitize_strips_control_chars_and_caps_length():
    dirty = "You are\n\tcurt.\x00\x07 " + "x" * 800
    clean = portrait._sanitize(dirty)
    assert len(clean) <= portrait.MAX_PORTRAIT_CHARS
    assert "\n" not in clean and "\t" not in clean and "\x00" not in clean
    assert clean.startswith("You are")
    assert portrait._sanitize("") == "" and portrait._sanitize(None) == ""


def test_synthesize_stores_sanitized_portrait(monkeypatch):
    raw = "You work in AI and prefer short,\n direct answers.\x07 " + "y" * 800
    fake = FakeProvider(raw)
    monkeypatch.setattr(portrait.resolver, "extractor", lambda _uid: fake)

    conn = _conn()
    try:
        with conn.cursor() as cur:
            uid = _make_user(cur)
        conn.commit()

        portrait.synthesize(uid)

        got = portrait.get(uid)
        assert fake.calls == 1                       # the FREE credential was used once
        assert got is not None
        assert len(got) <= portrait.MAX_PORTRAIT_CHARS  # capped
        assert "\n" not in got and "\x07" not in got    # control chars stripped
        assert got.startswith("You work in AI")
    finally:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM users WHERE id = %s", (uid,))
        conn.commit()
        conn.close()


def test_unchanged_fingerprint_skips_llm(monkeypatch):
    monkeypatch.setattr(portrait.resolver, "extractor",
                        lambda _uid: FakeProvider("You are a person who likes coffee."))
    conn = _conn()
    try:
        with conn.cursor() as cur:
            uid = _make_user(cur)
        conn.commit()

        portrait.synthesize(uid)          # first run writes the portrait + fingerprint

        # Facts unchanged => the second run must NOT reach the LLM at all.
        second = FakeProvider("SHOULD NEVER BE STORED")
        monkeypatch.setattr(portrait.resolver, "extractor", lambda _uid: second)
        portrait.synthesize(uid)
        assert second.calls == 0
    finally:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM users WHERE id = %s", (uid,))
        conn.commit()
        conn.close()


def test_no_free_credential_no_write_no_raise(monkeypatch):
    monkeypatch.setattr(portrait.resolver, "extractor", lambda _uid: None)
    conn = _conn()
    try:
        with conn.cursor() as cur:
            uid = _make_user(cur)
        conn.commit()

        portrait.synthesize(uid)          # must not raise
        assert portrait.get(uid) is None  # and must not have written a portrait
    finally:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM users WHERE id = %s", (uid,))
        conn.commit()
        conn.close()
