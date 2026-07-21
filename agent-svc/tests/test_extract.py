"""parse() is pure and branchy — that is the check. Table-driven, stdlib asserts.

extract()'s own branches (who pays, the retry, grounding) are covered by the two
tests at the bottom with a fake provider; everything else is parse().
"""
import json

import pytest

from llm import resolver
from llm.openai_compat import OpenAICompatProvider
from memory import extract

LOCAL = {"provider": "local", "auth_type": "api_key",
         "base_url": "http://localhost:11434/v1", "model_id": "qwen2.5:7b"}
PAID = {"provider": "anthropic", "auth_type": "api_key", "api_key": "sk-x",
        "model_id": "claude-opus-4-8"}

GOOD = '{"items": [{"subject": "user", "predicate": "lives in", "object": "Berlin"}]}'


@pytest.mark.parametrize(
    "name,text,want",
    [
        (
            "clean json",  # no confidence field -> explicit default (0.95)
            GOOD,
            [{"kind": "triple", "subject": "user", "predicate": "lives in",
              "object": "Berlin", "confidence": 0.95}],
        ),
        (
            "fenced json with preamble and trailing prose",
            "Sure! Here is the JSON you asked for:\n```json\n" + GOOD + "\n```\nHope that helps!",
            [{"kind": "triple", "subject": "user", "predicate": "lives in",
              "object": "Berlin", "confidence": 0.95}],
        ),
        ("prose only", "I could not find any durable facts in that exchange.", []),
        ("empty string", "", []),
        # {"items": []} is CORRECT for a trivial turn, not a failure.
        ("valid empty", '{"items": []}', []),
        ("truncated json", '{"items": [{"subject": "user", "predicate": "lives', []),
        (
            "one bad item keeps the good ones",
            '{"items": [{"subject": 5, "predicate": "lives in", "object": "Berlin"},'
            ' {"subject": "user", "predicate": "drinks", "object": "tea"},'
            ' "not even an object"]}',
            [{"kind": "triple", "subject": "user", "predicate": "drinks",
              "object": "tea", "confidence": 0.95}],
        ),
        (
            "note item, tagged inferred",
            '{"items": [{"note": "prefers short answers", "confidence": "inferred"}]}',
            [{"kind": "note", "content": "prefers short answers", "confidence": 0.70}],
        ),
        (
            "bare list, no items wrapper -> explicit default",
            '[{"note": "prefers short answers"}]',
            [{"kind": "note", "content": "prefers short answers", "confidence": 0.95}],
        ),
    ],
)
def test_parse_table(name, text, want):
    assert extract.parse(text) == want, name


def test_confidence_menu():
    def conf(v):
        return extract.parse('{"items": [{"note": "x", "confidence": %s}]}' % v)[0]["confidence"]

    assert conf('"explicit"') == 0.95
    assert conf('"inferred"') == 0.70  # the ONLY tag that lowers a fact
    assert conf('"high"') == 0.95  # off-menu -> explicit default, not a guessed-low
    assert conf("null") == 0.95  # omitted/None -> explicit; a grounded fact is stated
    assert conf("0.42") == 0.42
    assert conf("7") == 1.0  # clamped
    assert conf("-3") > 0  # db CHECK is confidence > 0


def test_caps_mirror_the_db_checks():
    def one(field, n, cap):
        item = {"subject": "user", "predicate": "likes", "object": "tea"}
        item[field] = "x" * n
        return extract.parse(json.dumps({"items": [item]}))

    assert one("object", 300, 300) != []      # at the CHECK limit: kept
    assert one("object", 301, 300) == []      # over it: dropped here, not at INSERT
    assert one("subject", 121, 120) == []
    assert one("predicate", 81, 80) == []


def test_item_cap():
    fifty = ", ".join('{"note": "n%d"}' % i for i in range(50))
    assert len(extract.parse('{"items": [%s]}' % fifty)) == extract.MAX_ITEMS


def test_parse_never_raises():
    for junk in [None, "{", "]", "{'items': ['", '{"items": {"a": 1}}', "\x00", "{}"]:
        assert extract.parse(junk) == []


def _creds(monkeypatch, active, lifeboat):
    monkeypatch.setattr(resolver, "_fetch_active", lambda uid: active)
    monkeypatch.setattr(resolver, "_fetch_lifeboat", lambda uid: lifeboat)


def test_extractor_uses_local_active(monkeypatch):
    _creds(monkeypatch, LOCAL, None)
    assert resolver.extractor("u").provider == "local"


def test_extractor_never_bills_the_paid_active_credential(monkeypatch):
    # The whole ruling: extraction is work the user did not ask for.
    _creds(monkeypatch, PAID, None)
    assert resolver.extractor("u") is None


def test_extractor_falls_back_to_the_lifeboat(monkeypatch):
    _creds(monkeypatch, PAID, LOCAL)
    assert resolver.extractor("u").provider == "local"


class FakeProvider:
    """Not an OpenAICompatProvider, so _ask asks for no optional params."""

    def __init__(self, *replies):
        self.replies = list(replies)
        self.calls = 0
        self.kw = None

    def chat(self, messages, system=None, tools=None, max_tokens=1024, **kw):
        self.calls += 1
        self.prompt = messages[0]["content"]
        self.kw = kw
        text = self.replies.pop(0) if self.replies else ""
        return type("R", (), {"text": text})()


def test_anthropic_is_never_asked_for_params_it_does_not_have():
    p = FakeProvider(GOOD)
    extract.extract(p, "I live in Berlin", "Nice!")
    assert p.kw == {}  # json_mode/reasoning are openai_compat-only


def test_openai_compat_extraction_disables_thinking(monkeypatch):
    """THE REGRESSION: a thinking model returns content='' until it stops
    deliberating, so extraction got NOTHING from every thinking model."""
    p = OpenAICompatProvider(
        base_url="http://localhost:11434/v1", api_key="k", model="qwen3.5:latest"
    )
    seen = {}

    def fake_chat(messages, system=None, tools=None, max_tokens=1024, **kw):
        seen.update(kw)
        return type("R", (), {"text": GOOD})()

    monkeypatch.setattr(p, "chat", fake_chat)
    assert extract.extract(p, "I live in Berlin", "Nice!")[0]["object"] == "Berlin"
    assert seen == {"json_mode": True, "reasoning": False}


def test_no_provider_stores_nothing():
    assert extract.extract(None, "I live in Berlin", "nice") == []


def test_ungrounded_item_is_dropped():
    p = FakeProvider('{"items": [{"subject": "user", "predicate": "owns", "object": "Ferrari"}]}')
    assert extract.extract(p, "I live in Berlin", "Nice, Berlin is great.") == []


def test_grounded_item_survives():
    p = FakeProvider(GOOD)
    assert extract.extract(p, "I live in Berlin", "Nice!")[0]["object"] == "Berlin"


def test_communication_style_directive_is_captured_and_grounded():
    # "short" and "version" are the user's own words, so the style item grounds.
    style = ('{"items": [{"subject": "user", "predicate": "prefers", "object": "short version"},'
             ' {"note": "wants the short version from now on"}]}')
    p = FakeProvider(style)
    kept = extract.extract(p, "just give me the short version from now on", "Sure.")
    assert kept, "an explicit style directive must survive grounding"
    assert any("short" in (it.get("object") or it.get("content")) for it in kept)
    # explicit directive -> no inferred tag -> high confidence
    assert all(it["confidence"] == extract.CONF_EXPLICIT for it in kept)


def test_trivia_turn_yields_no_style_item():
    # The model correctly returns nothing on a plain fact question.
    p = FakeProvider('{"items": []}')
    assert extract.extract(p, "what's the capital of France?", "Paris.") == []


def test_retry_on_parse_failure_only():
    p = FakeProvider("here is my answer: none", GOOD)
    assert extract.extract(p, "I live in Berlin", "Nice!")[0]["object"] == "Berlin"
    assert p.calls == 2  # parse failure -> exactly one retry

    q = FakeProvider('{"items": []}', GOOD)
    assert extract.extract(q, "capital of France?", "Paris.") == []
    assert q.calls == 1  # a correct empty result is NEVER retried


def test_provider_failure_stores_nothing_without_paying_twice():
    class Dead(FakeProvider):
        def chat(self, *a, **k):
            self.calls += 1
            raise RuntimeError("boom")

    d = Dead()
    assert extract.extract(d, "I live in Berlin", "Nice!") == []
    assert d.calls == 1


def test_input_is_truncated_head_biased():
    p = FakeProvider('{"items": []}')
    head, tail = "I live in Berlin. ", " AND MY CAT IS CALLED TAIL"
    extract.extract(p, head + "x" * extract.MAX_INPUT_CHARS + tail, "ok")
    assert head in p.prompt and tail not in p.prompt
