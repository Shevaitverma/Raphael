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
import logging

from llm.openai_compat import OpenAICompatProvider

_log = logging.getLogger(__name__)

MAX_ITEMS = 5
MAX_INPUT_CHARS = 1200  # head-biased: a truncated fact is a FABRICATED fact.
# ponytail: 768 gives a thinking cred room to finish deliberating and still emit
# content; the real fix is the provider honoring reasoning_effort (outOfScope).
MAX_OUTPUT_TOKENS = 768

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

Also capture HOW the user wants to be talked to and their durable traits, when
they express it — this is what lets you adapt to them:
- Communication style: preferred verbosity ("prefers short answers", "wants
  detail"), tone/formality, language.
- Preferences, interests, working style — durable likes/dislikes about how they
  work, not one-off mood.
- Explicit behavioral directives — "always...", "never...", "from now on...",
  "call me X", "stop doing Y". These are commands about your behaviour; record
  them as a note or a "user prefers"/"user wants" triple, NOT as inferred (the
  user said it outright, so confidence is explicit).

Rules:
- Only durable things about the user. Not world trivia, not the question itself,
  not anything true of everyone.
- NEVER record the assistant's own name, identity, or persona. "What is your
  name?" and its answer contain NO fact about the user.
- A name or nickname the user uses FOR YOU (the assistant) is NOT a fact about
  the user. "hi Akku", "thanks Sage", "hey buddy" = they addressed you; it does
  NOT mean the user is named or called that. Only record a name when the user
  claims it for THEMSELVES ("I'm Sam", "call me Sam", "my name is Sam").
- Never store the answer to a question the user asked, or anything the assistant
  said about itself — only what the USER asserted about themselves.
- NEVER record a request for you to DO something as a fact. "Remind me to drink
  water today", "add a task", "log my workout", "put it in my calendar" are
  ACTIONS: a tool performs them and the resulting row has its own lifetime (a
  reminder stops when its schedule ends). Storing "user wants reminders about
  drinking water" as a durable belief outlives the reminder, so you keep acting on
  a request the user made once, for one day, forever. Record nothing for these.
  A standing PREFERENCE the user states about themselves is different and IS
  durable: "I drink a lot of water" or "I prefer short answers" are facts; "remind
  me to drink water at 5pm" is not.
- Prefer a triple; use a note only when it truly cannot be one.
- Add "confidence": "inferred" ONLY when you GUESSED something the user did not
  say outright. Omit the field for anything the user stated directly.
- At most 5 items. Use words from the exchange.
- Nothing durable in the exchange? Output exactly: {"items": []}

Example
Message: I moved to Berlin last month, think I'll stay a while.
Answer: Congrats on the move!
Output: {"items": [{"subject": "user", "predicate": "lives in", "object": "Berlin"}, {"note": "moved to Berlin recently and plans to stay"}]}

Example
Message: from now on just give me the short version, skip the preamble.
Answer: Got it, I'll keep it short.
Output: {"items": [{"subject": "user", "predicate": "prefers", "object": "short answers"}, {"note": "wants the short version, skip preamble"}]}"""

# Grounding stopwords: enough to stop "the"/"and" from grounding a hallucination.
# The two-char block matters since _words admits len>=2: without it a fabricated
# "in Paris" grounds against any message containing "in" (function-word overlap,
# not evidence). Content two-char tokens ("AI", "42") are NOT here, so still keep.
_STOP = {
    "the", "and", "for", "you", "your", "our", "this", "that", "with", "was",
    "are", "have", "has", "had", "not", "but", "his", "her", "its", "they",
    "them", "their", "user", "assistant", "can", "will", "would", "should",
    "about", "from", "there", "here", "what", "when", "who", "how", "why",
    "am", "an", "as", "at", "be", "by", "do", "he", "if", "in", "is", "it",
    "me", "my", "no", "of", "on", "or", "so", "to", "up", "us", "we",
}


def _words(s: str, min_len: int = 2) -> set[str]:
    """Content words, no regex: fold every non-alphanumeric to a space.

    min_len defaults to 2 for GROUNDING, where a two-char object is a real claim
    ("AI", "42"). The skip-gate (workflow.py) passes min_len=3 instead: a message
    whose only tokens are two-char fillers ("ok", "hi", "no") is not worth an
    extraction call. One rule, two thresholds, so the gate never fires on "ok"
    while grounding still rescues "AI".
    """
    flat = "".join(c if c.isalnum() else " " for c in s.lower())
    return {w for w in flat.split() if len(w) >= min_len and w not in _STOP}


# A recall turn asks the assistant to REMEMBER, so its answer is retrieval, not a
# user assertion — grounding a fact against that answer would re-inscribe recalled
# data as a fresh explicit user fact (retrieval-feedback poisoning).
_WH_AUX = {
    "where", "what", "when", "who", "why", "how", "which",
    "do", "did", "does", "is", "are", "was", "were", "can", "could",
}

# Request-for-information markers: recall phrased as an imperative or statement
# ("tell me where I was born", "remind me of my birthplace") never reaches a '?'
# and never leads with a WH/aux word, so the answer — still retrieved data — would
# re-inscribe as a fresh explicit user fact. Match the phrase so answer-grounding
# stays OFF on these turns too.
_RECALL_MARKERS = ("tell me", "remind me", "show me", "recall", "what's my", "who's my")


def _is_recall(msg: str) -> bool:
    m = (msg or "").strip().lower()
    if not m:
        return False
    if m.endswith("?") or m.split()[0] in _WH_AUX:
        return True
    return any(k in m for k in _RECALL_MARKERS)


def _grounded(payload: str, message: str, _answer: str = "") -> bool:
    """A content word of the payload must appear in what the USER said. Full stop.

    This used to also accept a match against the ASSISTANT's answer, off a
    "recall" turn, to rescue facts a 7B rephrases ("I do not eat meat" -> object
    "vegetarian", echoed only in the answer). That was a closed feedback loop and
    it fired in production: on "give me details about myself" — which _is_recall
    does not catch, since it has no "?", no leading WH/aux word and "give me" was
    not a recall marker — the assistant recited the profile AND invented "your
    partner Ankita is allergic". Answer-grounding then wrote the invention back as
    a durable note, which fed the portrait, which produced a bigger invention next
    turn.

    An audit of every row written on 2026-07-26 found ALL of them answer-only
    grounded and none message-grounded: the rescue case is hypothetical, the
    poisoning was measured. So the answer is no longer trusted as evidence at all.

    The failure modes are not symmetric. Dropping a real fact costs one exchange
    and the user can restate it. Storing a hallucination is permanent, invisible to
    the user until it surfaces in a reply, and compounds through the portrait.
    `_answer` is kept in the signature so callers and tests need no change.
    """
    return bool(_words(payload) & _words(message))


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
    # Omitted/None/garbage -> INFERRED. The old default was explicit, on the theory
    # that grounding already proved the user's own words. An audit of the live data
    # killed that: a 7B essentially never emits the tag, so EVERY stored row was
    # 0.95 and the column carried no information at all — 0.70 had never once been
    # written. The UI then labelled 100% of beliefs "high confidence", which is a
    # confident-sounding lie about provenance.
    # "The model did not say" is not evidence, so it now reads as inferred. A model
    # that DOES tag something explicit still gets 0.95.
    return CONF_INFERRED


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

    # GROUNDING keeps only items whose payload traces to what the USER said (or,
    # off a recall turn, what the assistant echoed). See _grounded above.
    def _payload(it: dict) -> str:
        return (it.get("object") if it.get("kind") == "triple" else it.get("content")) or ""

    kept = [it for it in items if _grounded(_payload(it), message, answer)]
    # parsed vs kept separates "the model found nothing" from "grounding dropped
    # it": workflow.py's items= now equals kept, so a high parsed/low kept is the
    # signal that grounding is over-tight, not that extraction is silent.
    _log.info("extract parsed=%d kept=%d", len(items), len(kept))
    return kept


def demo() -> None:
    """Only the USER's own words ground a fact. The assistant's answer never does."""
    # KEEP: the payload echoes something the user actually said.
    assert _grounded("AI", "I work in AI", "")
    assert _grounded("42", "I am 42", "")
    assert _grounded("Acme", "I work at Acme", "")

    # DROP: present ONLY in the assistant's answer. This is the regression guard for
    # the confabulation loop — on "give me details about myself" the model recited
    # the profile and invented "your partner Ankita is allergic", and answer-
    # grounding wrote that invention back as a durable note. Every row written on
    # 2026-07-26 was answer-only grounded; none was message-grounded.
    assert not _grounded("vegetarian", "I do not eat meat", "noting you are vegetarian")
    assert not _grounded("allergic", "give me details about myself", "your partner is allergic")
    # The old code exempted "recall" turns only. That was too narrow: "give me
    # details about myself" trips none of the recall heuristics, which is exactly
    # how the poisoning got through. Now the answer is never evidence, recall or not.
    assert not _grounded("Reykjavik", "where was I born?", "You were born in Reykjavik")
    assert not _grounded("Reykjavik", "tell me where I was born", "You were born in Reykjavik")

    # DROP: two-char function-word overlap is not evidence ("in" alone must fail).
    assert not _grounded("in Paris", "I am interested in cooking", "")
    # The skip-gate threshold (min_len=3) must reject 2-char fillers so an "ok"
    # turn is never sent to the extractor, while grounding (default 2) keeps "AI".
    assert _words("ok", 3) == set() and _words("AI") == {"ai"}

    # An omitted confidence is NOT evidence of an explicit statement: a 7B almost
    # never emits the tag, and defaulting to 0.95 made the column meaningless.
    assert _conf(None) == CONF_INFERRED and _conf("explicit") == CONF_EXPLICIT
    print("extract.demo OK")


if __name__ == "__main__":
    demo()
