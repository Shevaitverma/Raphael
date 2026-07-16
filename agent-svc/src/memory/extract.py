"""LLM extraction of durable facts from an ordinary chat turn.

This runs on EVERY exchange, not on special events. That is the whole point: a
regex on the hot path with an LLM reserved for calendar invites learns nothing
about the person you actually talk to.

WHO PAYS. resolver.extractor(user_id) — local if active, else the lifeboat,
else None. None means no extraction and NOTHING stored. Silence without spend
is a legitimate state; silence WITH spend is not.

THE JSON LADDER, cheapest first:
  1. json_mode + reasoning=False on openai_compat only (the honest test for
     "takes these params" — Anthropic has neither; its coercion is forced
     tool-use). The provider downgrades on a 400 and remembers it per model.

     reasoning=False is not a tuning knob, it is load-bearing: a THINKING model
     leaves `content` EMPTY until it stops deliberating, so qwen3.5 burned a
     512-token budget thinking about {"ok":true} and returned "". Extraction is
     mechanical and never benefits from chain-of-thought, so this is correct on
     the merits — cheaper and faster are the side effects.
  2. A prompt a 7B survives: flat items, one worked example, an explicit empty
     literal, a hard item cap.
  3. json.JSONDecoder().raw_decode — it stops at the end of the first valid
     value, so fences, preambles and trailing prose fall out for free. No
     regex, no fence-stripping, no dependency.
  4. ONE retry on PARSE FAILURE ONLY. {"items": []} for "capital of France?" is
     CORRECT; retrying it doubles the cost of every trivial turn to punish the
     model for being right.
  5. Give up -> store NOTHING. Never a partial object, never the raw turn as
     consolation. A bad durable fact poisons retrieval forever and the user
     never sees it to correct it; a missing one costs one exchange.
"""
from __future__ import annotations

import json

from llm.openai_compat import OpenAICompatProvider

MAX_ITEMS = 5
MAX_INPUT_CHARS = 1200  # head-biased: a truncated fact is a FABRICATED fact.
MAX_OUTPUT_TOKENS = 512

# Mirror the db CHECKs (db/003_memory.sql:95-97) so an overlong item is dropped
# HERE rather than aborting the whole batch on an INSERT.
CAP_SUBJECT, CAP_PREDICATE, CAP_OBJECT = 120, 80, 300
CAP_NOTE = 300  # memories.content has no CHECK; unbounded notes are the old bug.

# A TWO-ITEM MENU, not a float. Models are badly calibrated on free-form
# probabilities and reliable at picking from an enumerated set.
CONF_EXPLICIT, CONF_INFERRED = 0.95, 0.70

SYSTEM = """Extract durable facts about the user from one exchange. Output JSON only.

Schema — each item is either a triple or a note:
{"items": [{"subject": "user", "predicate": "works at", "object": "Acme"},
           {"note": "prefers short answers"}]}

Rules:
- Only durable things about the user. Not world trivia, not the question itself,
  not anything true of everyone.
- Add "confidence": "explicit" ONLY if the user stated it outright. Omit the
  field when you inferred it.
- At most 5 items. Use words from the exchange.
- Nothing durable in the exchange? Output exactly: {"items": []}

Example
Message: I moved to Berlin last month, think I'll stay a while.
Answer: Congrats on the move!
Output: {"items": [{"subject": "user", "predicate": "lives in", "object": "Berlin", "confidence": "explicit"}, {"note": "moved to Berlin recently and plans to stay"}]}"""

# Grounding stopwords: enough to stop "the"/"and" from grounding a hallucination.
_STOP = {
    "the", "and", "for", "you", "your", "our", "this", "that", "with", "was",
    "are", "have", "has", "had", "not", "but", "his", "her", "its", "they",
    "them", "their", "user", "assistant", "can", "will", "would", "should",
    "about", "from", "there", "here", "what", "when", "who", "how", "why",
}


def _words(s: str) -> set[str]:
    """Content words, no regex: fold every non-alphanumeric to a space."""
    flat = "".join(c if c.isalnum() else " " for c in s.lower())
    return {w for w in flat.split() if len(w) > 2 and w not in _STOP}


def _text(v, cap: int) -> str | None:
    if not isinstance(v, str):
        return None
    v = v.strip()
    return v if v and len(v) <= cap else None


def _conf(v) -> float:
    if isinstance(v, str):
        v = {"explicit": CONF_EXPLICIT, "inferred": CONF_INFERRED}.get(v.strip().lower(), v)
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        # db CHECK is confidence > 0, so the floor is 0.01 and not 0.
        return min(1.0, max(0.01, float(v)))
    return CONF_INFERRED  # "high", None, garbage -> the inferred tier.


def _item(raw) -> dict | None:
    if not isinstance(raw, dict):
        return None
    conf = _conf(raw.get("confidence"))
    s = _text(raw.get("subject"), CAP_SUBJECT)
    p = _text(raw.get("predicate"), CAP_PREDICATE)
    o = _text(raw.get("object"), CAP_OBJECT)
    if s and p and o:
        return {"kind": "triple", "subject": s, "predicate": p, "object": o, "confidence": conf}
    note = _text(raw.get("note"), CAP_NOTE)
    if note:
        return {"kind": "note", "content": note, "confidence": conf}
    return None


def _first_json(text: str):
    """The first complete JSON value in text, or None.

    raw_decode stops at the end of the first valid value, so trailing prose and
    closing fences are free. Scanning candidate openers makes preambles and
    ```json fences free too — without owning a fence-stripper that rots the day
    a model emits ~~~ instead.
    """
    dec = json.JSONDecoder()
    for i, c in enumerate(text):
        if c in "{[":
            try:
                return dec.raw_decode(text, i)[0]
            except ValueError:
                continue  # prose brace, or truncated JSON: keep looking.
    return None


def _parse(text: str) -> list[dict] | None:
    """None = PARSE FAILURE (retryable). [] = the model validly found nothing."""
    obj = _first_json(text or "")
    items = obj.get("items") if isinstance(obj, dict) else obj
    if not isinstance(items, list):
        return None
    # One bad item never costs the good ones.
    return [it for it in (_item(r) for r in items) if it][:MAX_ITEMS]


def parse(text: str) -> list[dict]:
    """Malformed -> []. Never raises."""
    return _parse(text) or []


def _ask(provider, prompt: str) -> str:
    msgs = [{"role": "user", "content": prompt}]
    # isinstance is the honest test for "takes these params" — Anthropic has
    # neither. The provider itself downgrades on a 400 and remembers it, so this
    # asks for both knobs unconditionally and never inspects the outcome.
    extra = (
        {"json_mode": True, "reasoning": False}
        if isinstance(provider, OpenAICompatProvider)
        else {}
    )
    try:
        return provider.chat(msgs, system=SYSTEM, max_tokens=MAX_OUTPUT_TOKENS, **extra).text or ""
    except Exception:
        return ""  # dead or transient: extraction is best-effort, never fatal.


def extract(provider, message: str, answer: str) -> list[dict]:
    """Durable items from one exchange. No provider -> []. Never raises."""
    if provider is None:
        return []
    message, answer = (message or "")[:MAX_INPUT_CHARS], (answer or "")[:MAX_INPUT_CHARS]
    prompt = f"Message: {message}\nAnswer: {answer}\nOutput:"

    text = _ask(provider, prompt)
    if not text.strip():
        return []  # nothing came back: store NOTHING, and do not pay twice for it.
    items = _parse(text)
    if items is None:
        items = _parse(_ask(provider, prompt)) or []  # ONE retry, parse failure only.

    # GROUNDING: at least one content word of the item must appear in the
    # exchange. This is what turns "the 7B hallucinated a field" from a stored
    # lie into a no-op.
    seen = _words(message) | _words(answer)
    return [
        it
        for it in items
        if _words(" ".join(v for k, v in it.items() if k != "kind" and isinstance(v, str))) & seen
    ]
