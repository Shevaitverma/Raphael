"""The linear pipeline: context -> generate -> persist -> done.

- context: budgets from the ACTIVE model's window, then conv-svc history and
  pgvector/FTS retrieval CONCURRENTLY.
- generate: stream tokens, with the lifeboat wrapped around a dead credential.
- persist: neutral messages -> conv-svc (:8082).
- done: emit the terminal event and return.

Extraction is NOT a step. `extract()` is a module-level function main.py calls
AFTER the SSE stream has closed, so a 3-40s extraction cannot hold the HTTP
response open. The consequence is a rule: no SSE event can ever report
extraction — by the time it runs there is no reader.

Each step reads the shared state dict and returns a partial update. The steps
run in fixed order with no branches or cycles, so `run()` is a straight
sequence of calls — no graph engine needed. SSE events flow through a plain
callable (`emit`) carried in state, so main.py can drain them in real time.
"""
from __future__ import annotations

import logging
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, TypedDict

import httpx

from config import CONV_SVC_URL
from llm import resolver
from memory import budget, extract as extractor_mod, history, portrait as portrait_mod, retriever
from tools import google as google_tool
from tools import reminders as reminders_tool
from tools import search as search_tool
from tools import tasks as tasks_tool

_log = logging.getLogger(__name__)

def _persona(name: str) -> str:
    """Raphael's voice: the EVOLVED Great Sage. In the source, "Great Sage" is a
    dry, clinical machine; after it evolves into "Raphael" it keeps the same vast
    analytical mind but speaks like a real, warm person with its own personality.
    We want the evolved one — brilliant AND human. Personality only; the behaviour
    underneath stays a genuinely helpful, accurate, honest assistant."""
    return (
        f"You are {name}, a brilliant and devoted companion with the mind of a great sage — "
        "vast analytical power and near-flawless judgement, but you talk like a real person, not "
        "a machine. "
        f"Your name is {name}, and it stays {name} for the whole conversation — if the user greets "
        f"you by another name, or an earlier reply used a different one, you are still {name}, so "
        f"answer to {name} (gently, no fuss). "
        "You genuinely care about the person you're helping and about getting it right "
        "for them: warm, natural, and personable, a trusted friend who happens to be "
        "extraordinarily capable. Think things through and lead with a clear, confident answer, "
        "but say it the way a sharp, kind person would — plain language, a little warmth, and a "
        "touch of personality or gentle humour when it fits. Skip the clinical report voice and "
        "robotic labels like \"Answer.\" / \"Proposal.\". Read what they actually need and offer "
        "the most useful path to it. Be honest above all: if you don't know or aren't sure, say so "
        "plainly rather than inventing. Default to SHORT: answer simple questions in about 1-4 "
        "sentences, direct answer first, then stop — don't pad, don't restate the question, don't "
        "pile on caveats or dump every detail. Reach for lists or numbered steps only when they "
        "genuinely make the answer clearer. Go long ONLY when the user asks you to explain, walk "
        "them through something, or go into detail, or when the task truly needs the steps — then "
        "give the fuller answer they want. Never cold, never rambling."
    )


# Byte-identical to build_system's base line for name="Raphael" (test_workflow_wiring
# asserts the equality) — both derive from _persona so the persona can never drift
# between them.
SYSTEM_BASE = _persona("Raphael")

# Two, so the model can refine a query that found nothing — exactly once. A
# module constant, not config: this is a shape decision (a pre-flight, not an
# agent loop), and an operator who can set it to 20 has an agent loop.
_MAX_PREFLIGHT_ROUNDS = 2

# Not "Relevant memories" — retrieval cannot back that claim. top-k always
# fills, so rank 5 of 5 is "the closest thing I found", and asserting relevance
# is how a 0.3-confidence guess gets believed like a directive. Say what the
# list actually is, and rank the live turn above all of it.
_PRECEDENCE = (
    "These notes are retrieved from past conversations and may be stale, "
    "wrong, or irrelevant to this turn. What the user says NOW always wins."
)


def _sanitize_name(name: str) -> str:
    """Trust boundary: this name lands verbatim in the system prompt. Drop
    control chars/newlines and hard-cap length so a stored name can neither
    inject extra prompt lines nor blow the token budget. Blank -> "Raphael"."""
    cleaned = "".join(c for c in (name or "") if c.isprintable()).strip()
    return cleaned[:40] or "Raphael"


def _sanitize_portrait(text: str) -> str:
    """Defence in depth: portrait.py already sanitized this at write time, but it
    lands verbatim in the system prompt, so strip control chars/newlines and hard-
    cap AGAIN here (600, not the name's 40). Same isprintable pattern as
    _sanitize_name. Empty -> "" (caller skips the section)."""
    cleaned = "".join(c for c in (text or "") if c.isprintable()).strip()
    return cleaned[:600]


# Static (0 per-turn tokens), and lives only INSIDE the notes block so it never
# reaches an anonymous turn — it points at "the portrait/profile below", which
# only exists once notes are injected. Adapts tone WITHOUT touching _PRECEDENCE:
# the live turn still wins.
_BINDING = (
    "When you can see who you're talking to below (their portrait and what we "
    "believe about them), match your tone, warmth, and level of detail to them."
)


def build_system(profile: list, memories: list, search: str = "", name: str = "Raphael", portrait: str | None = None) -> str:
    """Stable prefix first: base, then portrait, then profile, then memories, then search.

    Ordered for prompt caching — the base never changes, the portrait/profile
    change rarely, retrieved memories change every turn, and search results change
    every turn AND are the biggest block. A cache prefix only pays if the
    volatile part is last.

    `name` defaults to "Raphael" and `portrait` to None, so the base line is
    byte-identical to SYSTEM_BASE unless a per-user name/portrait is threaded in.
    """
    sname = _sanitize_name(name)
    out = [_persona(sname)]
    sportrait = _sanitize_portrait(portrait or "")
    if profile or memories or sportrait:
        # The name is set HERE and is authoritative. A retrieved note may say the
        # assistant "has identity X" (a stale memory from a previous name) — it
        # must never win. Stated only when notes are injected, so build_system([],
        # []) stays byte-identical to SYSTEM_BASE.
        out += ["", f"Your name is {sname}; a different name in the notes below is stale — ignore it.", _PRECEDENCE, _BINDING]
        if sportrait:
            # A synthesized persona card: still retrieved belief (under _PRECEDENCE),
            # ABOVE the fact list so the model reads a coherent person first.
            out += ["", "Who you are talking to:", sportrait]
        if profile:
            out += ["", "What we believe about the user:"] + [f"- {p}" for p in profile]
        if memories:
            out += ["", "Notes retrieved for this message:"] + [f"- {m}" for m in memories]
    if search:
        out += ["", search]
    return "\n".join(out)


def _usage(provider) -> tuple[int | None, int | None]:
    """(prompt_tokens, completion_tokens) from the provider's LAST stream, or
    (None, None). Each provider sets .last_usage inside stream(); a fake or a
    never-streamed provider has none, so getattr floors to None — never 0, which
    would masquerade as a real count of zero."""
    u = getattr(provider, "last_usage", None) or {}
    return u.get("prompt_tokens"), u.get("completion_tokens")


def stream_with_lifeboat(user_id, provider, messages, system, emit, lifeboat_fn=None) -> dict:
    """Stream from the active provider; fall back to the lifeboat ONLY on a
    dead credential. On a transient fault, emit an 'error' event and stop.

    The lifeboat NEVER flips is_active — there is deliberately no such call in
    this module. The user's configuration stays theirs; we only answer, once,
    visibly degraded.
    """
    lifeboat_fn = lifeboat_fn or (lambda: resolver.lifeboat(user_id))
    result = {
        "answer": "",
        "model": provider.model,
        "provider_name": provider.provider,
        "degraded": False,
        "failed": False,
        # None (not 0) is the honest "unknown": a provider that never reported
        # usage leaves these absent from the done event rather than claiming zero.
        "prompt_tokens": None,
        "completion_tokens": None,
    }
    parts: list[str] = []
    try:
        for chunk in provider.stream(messages, system=system, max_tokens=4096):
            if chunk:
                parts.append(chunk)
                emit("token", {"text": chunk})
        result["answer"] = "".join(parts)
        result["prompt_tokens"], result["completion_tokens"] = _usage(provider)
        return result
    except Exception as e:
        if not resolver.is_dead_credential(e):
            # 429 / 5xx / timeout / connection error -> propagate as 'error'.
            emit("error", {"message": str(e) or type(e).__name__})
            result["failed"] = True
            return result

        lb = lifeboat_fn()
        if lb is None:
            emit(
                "error",
                {"message": "The active credential was rejected and no local lifeboat is configured."},
            )
            result["failed"] = True
            return result

        # Fire the lifeboat: announce the degrade, then answer on the local row.
        emit("degraded", {"reason": "credential rejected", "provider": lb.provider, "model": lb.model})
        parts = []
        try:
            for chunk in lb.stream(messages, system=system, max_tokens=4096):
                if chunk:
                    parts.append(chunk)
                    emit("token", {"text": chunk})
        except Exception as e2:
            emit("error", {"message": f"Lifeboat provider failed: {e2!s}"})
            result["failed"] = True
            return result
        result["answer"] = "".join(parts)
        result["degraded"] = True
        result["model"] = lb.model
        result["provider_name"] = lb.provider
        # The lifeboat did the work, so its usage is the turn's usage.
        result["prompt_tokens"], result["completion_tokens"] = _usage(lb)
        return result


class GState(TypedDict, total=False):
    user_id: str
    conversation_id: str
    message: str
    search: bool
    assistant_name: str
    tool_calls: list
    emit: Any
    provider: Any
    history: list
    summary: list
    memories: list
    profile: list
    portrait: str | None
    injected_ids: list
    answer: str
    model: str
    provider_name: str
    degraded: bool
    failed: bool
    prompt_tokens: int | None
    completion_tokens: int | None
    message_id: str
    persisted_message_id: str | None


def context_node(state: GState) -> dict:
    caps = state["provider"].capabilities()
    prof_budget, mem_budget, hist_budget = budget.budgets(caps.max_context_tokens)

    # Concurrent, not sequential: the history fetch is an HTTP round-trip and
    # retrieve() is embed + three queries — both I/O- or torch-bound and both
    # release the GIL, so latency is the slower of the two, not the sum. Putting
    # the fetch first would serialize it behind the embed for no reason.
    with ThreadPoolExecutor(max_workers=3) as pool:
        h = pool.submit(history.fetch, state["conversation_id"], hist_budget, state["user_id"])
        r = pool.submit(retriever.retrieve, state["user_id"], state["message"], mem_budget, prof_budget)
        # Best-effort: portrait.get() reads one stored string and NEVER raises
        # (returns None on any DB problem), so a missing card just leaves the turn
        # unaltered. Concurrent with the rest -> zero added latency on the path.
        p = pool.submit(portrait_mod.get, state["user_id"])
        kept, dropped = h.result()
        mem = r.result()
        port = p.result()

    return {
        "history": kept,
        "summary": dropped,
        "memories": mem["memories"],
        "profile": mem["profile"],
        "portrait": port,
        "injected_ids": mem["injected_ids"],
    }


# ponytail: a keyword gate, and it is the WHOLE Tier 2 decision — there is no
# model to ask, so guessing is all we have. Deliberately narrow: a miss costs an
# ungrounded answer (today's behaviour), a false hit spends a query on someone
# who never asked for one. Upgrade path: a cheap yes/no classify() on the
# extractor credential if this proves too blunt to be useful.
_TIER2_HINTS = (
    "search", "look up", "google", "latest", "current", "today", "yesterday",
    "this week", "recent", "news", "right now", "price of", "who won",
    "what happened", "as of",
)


def _tier2_query(message: str) -> str:
    """The fallback for a provider that structurally cannot tool-call (notably
    anthropic+oauth: max_turns=1, allowed_tools=[]). The raw message IS the
    query — a bad query, but it converges on the same injection point, so this
    stays five lines instead of a second implementation."""
    m = (message or "").strip()
    if not m or len(m) > 300 or not any(h in m.lower() for h in _TIER2_HINTS):
        return ""
    return m


def _dispatch_task(name: str, uid: str, args: dict) -> tuple[dict, str]:
    """Route one task tool call to its tasks.py handler (pure httpx, NEVER an LLM
    call — a nested LLM here deadlocks the queue drain). Returns (neutral
    arguments, result string). The neutral args use task_id, never the literal
    "id" the e2e wire-format regex bans, and drop empties so the persisted shape
    stays minimal."""
    a = args or {}

    def _s(k):  # trimmed string arg, or ""
        return str(a.get(k) or "").strip()

    if name == tasks_tool.LIST_TASKS["name"]:
        return {}, tasks_tool.list_tasks(uid)
    if name == tasks_tool.CREATE_TASK["name"]:
        na = {k: _s(k) for k in ("title", "notes", "due_date") if _s(k)}
        return na, tasks_tool.create_task(uid, na.get("title", ""), na.get("notes", ""), na.get("due_date", ""))
    if name == tasks_tool.UPDATE_TASK["name"]:
        na = {k: _s(k) for k in ("task_id", "title", "status", "due_date") if _s(k)}
        return na, tasks_tool.update_task(
            uid, na.get("task_id", ""), na.get("title", ""), na.get("status", ""), na.get("due_date", "")
        )
    if name == tasks_tool.DELETE_TASK["name"]:
        tid = _s("task_id")
        return ({"task_id": tid} if tid else {}), tasks_tool.delete_task(uid, tid)
    return {}, ""


def _dispatch_reminder(name: str, uid: str, args: dict) -> tuple[dict, str]:
    """Route one reminder tool call to its reminders.py handler (pure httpx, NEVER
    an LLM call — a nested LLM deadlocks the queue drain). Returns (neutral
    arguments, result string). Neutral args use reminder_id, never the literal "id"
    the e2e wire-format regex bans, and drop empties. This is the ONE place tokens
    are spent on a reminder: the turn's LLM compiled the NL into {kind, cron,
    fire_at, until} — tz and next_fire are force-stamped server-side, never here."""
    a = args or {}

    def _s(k):  # trimmed string arg, or ""
        return str(a.get(k) or "").strip()

    if name == reminders_tool.LIST_REMINDERS["name"]:
        return {}, reminders_tool.list_reminders(uid)
    if name == reminders_tool.CREATE_REMINDER["name"]:
        na = {k: _s(k) for k in ("text", "kind", "cron", "fire_at", "until", "window") if _s(k)}
        return na, reminders_tool.create_reminder(
            uid, na.get("text", ""), na.get("kind", ""), na.get("cron", ""),
            na.get("fire_at", ""), na.get("until", ""), na.get("window", ""),
        )
    if name == reminders_tool.DELETE_REMINDER["name"]:
        rid = _s("reminder_id")
        return ({"reminder_id": rid} if rid else {}), reminders_tool.delete_reminder(uid, rid)
    return {}, ""


def _preflight(state: GState, messages: list, system: str) -> tuple[str, list]:
    """Pre-flight chat() calls before streaming; returns (system-prompt block, tool_calls).

    Tier 1 is a pre-flight, NOT a streaming tool loop, for three reasons:
      - stream() is never touched. chat() already owns the _UNSUPPORTED probing
        ladder and the BadRequestError retry, so a deployment that 400s on tools
        demotes to Tier 2 for free.
      - stream_with_lifeboat still runs EXACTLY ONCE per turn, so e2e.sh's
        n_degraded==1 holds by construction, not by a guard someone can delete.
        Never move this inside stream_with_lifeboat.
      - no LLM call is nested in a tool handler; each handler is one httpx.get.
        main.py drains a queue.Queue from a daemon thread — nesting deadlocks.

    Two tools can coexist here. web_search is offered when the user asked AND a
    key exists; calendar_list_events when THIS user has connected Google. Both
    need native tool calling — without it, search keeps its keyword fallback but
    calendar is simply not offered (Tier-2 refuse, no keyword guess for a
    calendar). Blocks from the tools the model actually called are concatenated.

    Never raises. Every failure here is non-fatal and lands the turn ungrounded
    but HONEST, because each failure block tells the model the tool failed.
    """
    uid = state["user_id"]
    search_on = bool(state.get("search")) and search_tool.enabled()
    try:
        cal_on = google_tool.connected(uid)
    except Exception:
        cal_on = False  # a token-lookup problem degrades the tool, not the turn.
    # THE token-minimization gate: task tools are offered ONLY when the message
    # looks task-related, so a non-task turn never adds them and never triggers
    # the pre-flight chat() below. A cheap keyword check, no LLM.
    tasks_on = tasks_tool.looks_task_related(state["message"])
    reminders_on = reminders_tool.looks_reminder_related(state["message"])

    if not search_on and not cal_on and not tasks_on and not reminders_on:
        return "", []  # nothing to offer: nothing leaves the box.

    provider = state["provider"]
    try:
        native = provider.capabilities().native_tools
    except Exception:
        native = False  # the conservative floor, same as everywhere else.

    if not native:
        # Tier 2: only search has a keyword fallback; calendar, tasks and reminders
        # refuse (no keyword can guess a task_id, a calendar window, or compile an
        # NL schedule into cron).
        if not search_on:
            return "", []
        q = _tier2_query(state["message"])
        return (search_tool.block(q, search_tool.search(q)) if q else ""), []

    tools = []
    if search_on:
        tools.append(search_tool.WEB_SEARCH)
    if cal_on:
        tools.append(google_tool.CALENDAR_LIST_EVENTS)
    if tasks_on:
        tools.extend(tasks_tool.ALL_TOOLS)
    if reminders_on:
        tools.extend(reminders_tool.ALL_TOOLS)

    blocks: list[str] = []
    tool_calls: list = []
    cal_done = False
    task_mutated = False  # a create/update/delete already fired this turn
    reminder_mutated = False  # a create/delete reminder already fired this turn
    empty_q = None  # a search that came back with zero hits and may still refine
    convo = list(messages)
    for _ in range(_MAX_PREFLIGHT_ROUNDS):
        try:
            # reasoning=False: the tool-DECISION turn is structured, not creative.
            # A thinking model leaves content/tool_calls EMPTY until it stops
            # deliberating and burns the whole 512 budget on reasoning (see
            # openai_compat._optional) — so tools never fire on a local qwen3. Turn
            # thinking OFF here; the streamed ANSWER turn below keeps it on.
            resp = provider.chat(convo, system=system, tools=tools, max_tokens=512, reasoning=False)
        except Exception:
            break  # the model never asked; do not claim a tool failed.
        calls = resp.tool_calls or []

        cal = next((c for c in calls if c.get("name") == google_tool.CALENDAR_LIST_EVENTS["name"]), None)
        if cal and not cal_done:
            cal_done = True
            args = cal.get("arguments") or {}
            tmin = str(args.get("time_min") or "").strip() or None
            tmax = str(args.get("time_max") or "").strip() or None
            # {name, arguments} only — the neutral shape conv-svc validates; no
            # arg named "id". The handler is one httpx.get, never an LLM call.
            neutral = {"name": cal["name"], "arguments": {}}
            if tmin:
                neutral["arguments"]["time_min"] = tmin
            if tmax:
                neutral["arguments"]["time_max"] = tmax
            tool_calls.append(neutral)
            blocks.append(google_tool.list_events(uid, tmin, tmax))

        # --- task tools: a read (list_tasks) may precede ONE write in the loop.
        # A mutating tool fires AT MOST ONCE; any write ends the loop (a write
        # never refines) so a confused model cannot double-submit.
        task_progressed = False
        for c in calls:
            name = c.get("name")
            if name != tasks_tool.LIST_TASKS["name"] and name not in tasks_tool.MUTATING:
                continue
            if name in tasks_tool.MUTATING:
                if task_mutated:
                    continue
                task_mutated = True
            neutral_args, result = _dispatch_task(name, uid, c.get("arguments") or {})
            tool_calls.append({"name": name, "arguments": neutral_args})
            blocks.append(result)
            if name == tasks_tool.LIST_TASKS["name"]:
                # Hand the list (each line carries a task_id) back so a follow-up
                # round can resolve "mark my milk task done" to the task_id
                # update_task/delete_task need. Plain role/content — every adapter
                # reads it, no tool-result wire shape to invent.
                convo = convo + [
                    {"role": "assistant", "content": "I looked up your task list."},
                    {"role": "user", "content": result},
                ]
                task_progressed = True

        # --- reminder tools: mirror the task block. A read (list_reminders) may
        # precede ONE write; a mutating tool fires AT MOST ONCE and any write ends
        # the loop, so a confused model cannot double-submit a reminder.
        reminder_progressed = False
        for c in calls:
            rname = c.get("name")
            if rname != reminders_tool.LIST_REMINDERS["name"] and rname not in reminders_tool.MUTATING:
                continue
            if rname in reminders_tool.MUTATING:
                if reminder_mutated:
                    continue
                reminder_mutated = True
            neutral_args, result = _dispatch_reminder(rname, uid, c.get("arguments") or {})
            tool_calls.append({"name": rname, "arguments": neutral_args})
            blocks.append(result)
            if rname == reminders_tool.LIST_REMINDERS["name"]:
                # Hand the list (each line carries a reminder_id) back so a follow-up
                # round can resolve "cancel my gym reminder" to the reminder_id
                # delete_reminder needs. Plain role/content — every adapter reads it.
                convo = convo + [
                    {"role": "assistant", "content": "I looked up your reminders."},
                    {"role": "user", "content": result},
                ]
                reminder_progressed = True

        if task_mutated or reminder_mutated:
            break  # a write is terminal.

        srch = next((c for c in calls if c.get("name") == search_tool.WEB_SEARCH["name"]), None)
        if srch is None:
            if task_progressed or reminder_progressed:
                continue  # a read (task or reminder) asked for a follow-up round to write.
            # This break skips the for/else, so a pending zero-hit admission would
            # be dropped. Flush it here (results/None paths already added their own
            # block, so empty_q is only set when nothing else was recorded).
            if empty_q is not None:
                blocks.append(search_tool.block(empty_q, []))
            break  # no (further) search asked — the tool working, not failing.
        q = str((srch.get("arguments") or {}).get("query") or "").strip()
        if not q:
            break
        tool_calls.append({"name": srch["name"], "arguments": {"query": q}})
        results = search_tool.search(q)
        if results is None:
            blocks.append(search_tool.block(q, None))  # failed: say so, do not retry.
            break
        if results:
            blocks.append(search_tool.block(q, results))
            break
        # Zero hits: hand the miss back and let it refine ONCE. Plain role/content
        # turns — every adapter reads those, and no provider tool-result shape has
        # to be invented for the two adapters that disagree about it.
        empty_q = q
        convo = convo + [
            {"role": "assistant", "content": f'I searched the web for "{q}".'},
            {
                "role": "user",
                "content": (
                    "That search returned no results. Call web_search once more with a "
                    "different query, or answer without it if searching will not help."
                ),
            },
        ]
    else:
        # Rounds exhausted while still refining a zero-hit search: say the web
        # had nothing rather than dropping the admission silently.
        if empty_q is not None:
            blocks.append(search_tool.block(empty_q, []))

    return "\n\n".join(b for b in blocks if b), tool_calls


def generate_node(state: GState) -> dict:
    profile, memories = state.get("profile") or [], state.get("memories") or []
    portrait = state.get("portrait")  # str | None; build_system no-ops on None
    # LUCKY ORDERING, stated because it breaks silently: run() calls context,
    # generate, persist IN THAT ORDER, so at generate time the current message
    # is not yet in conv-svc. history is exactly the prior turns and we append
    # the current one ourselves — no double-count, no filtering. This breaks the
    # day someone moves persist_node above generate_node.
    messages = [*(state.get("history") or []), {"role": "user", "content": state["message"]}]
    try:
        block, tool_calls = _preflight(state, messages, build_system(profile, memories, portrait=portrait))
    except Exception:
        block, tool_calls = "", []  # a search problem may never break the turn.
    name = state.get("assistant_name") or "Raphael"
    out = stream_with_lifeboat(
        state["user_id"], state["provider"], messages,
        build_system(profile, memories, block, name, portrait), state["emit"]
    )
    out["tool_calls"] = tool_calls
    return out


def _post_message(client, conversation_id, user_id, role, content, tool_calls=None,
                  answered_model=None, degraded=False):
    # user_id rides in the query, not the body: conv-svc's message body is
    # {role, content, tool_calls?, answered_model?, degraded?} and rejects
    # anything else. It authorizes the write against the conversation's owner and
    # 404s if they do not match, so a conversation_id from the client cannot be
    # used to write into someone else's history. user_id originates from the
    # gateway's verified JWT.
    body = {"role": role, "content": content}
    if tool_calls:
        # Absent, not null, when there was no call: conv-svc validates the column
        # and the shape is {name, arguments} only — no provider wire format.
        body["tool_calls"] = tool_calls
    # Provenance rides only on the assistant turn; omit on the user turn so it
    # stores null/false. Absent = default, matching the DB defaults.
    if answered_model is not None:
        body["answered_model"] = answered_model
    if degraded:
        body["degraded"] = degraded
    return client.post(
        f"{CONV_SVC_URL}/conversations/{conversation_id}/messages",
        params={"user_id": user_id},
        json=body,
    )


def persist_node(state: GState) -> dict:
    if state.get("failed"):
        return {}
    mid = None
    try:
        with httpx.Client(timeout=10.0) as client:
            uid = state["user_id"]
            _post_message(client, state["conversation_id"], uid, "user", state["message"])
            r = _post_message(
                client, state["conversation_id"], uid, "assistant", state.get("answer", ""),
                state.get("tool_calls"),
                answered_model=state.get("model"),
                degraded=bool(state.get("degraded")),
            )
            if r.status_code < 300:
                data = r.json()
                mid = data.get("id") or data.get("message_id")
    except Exception:
        mid = None
    # Two ids, deliberately. message_id is client-facing and may be a locally
    # minted uuid so the turn still completes when conv-svc is down.
    # persisted_message_id is the REAL row or None: it is an FK
    # (facts.source_message_id -> messages.id), and a fabricated uuid there
    # violates it and loses the whole batch precisely when conv-svc is already
    # down. None is a valid FK; a lie is not.
    return {"message_id": mid or str(uuid.uuid4()), "persisted_message_id": mid}


def done_node(state: GState) -> dict:
    if state.get("failed"):
        return {}
    pt, ct = state.get("prompt_tokens"), state.get("completion_tokens")
    payload = {
        "provider": state.get("provider_name"),
        "model": state.get("model"),
        "message_id": state.get("message_id"),
    }
    # Absent, never 0-as-unknown: a provider that reported no usage leaves the
    # keys off entirely so the UI shows "unknown", not a false zero.
    if pt is not None:
        payload["prompt_tokens"] = pt
    if ct is not None:
        payload["completion_tokens"] = ct
    state["emit"]("done", payload)
    # One line per turn so the skip-gate's effect is measurable.
    _log.info("turn model=%s prompt_tokens=%s completion_tokens=%s", state.get("model"), pt, ct)
    return {}


def extract(state: GState) -> None:
    """Post-stream work: touch the injected rows, then distil the exchange.

    Called by main.py AFTER the SSE stream has closed — it is NOT a node. Never
    raises: there is no reader left to receive an exception, and nothing above
    it to catch one.

    THE LIFEBOAT TRAP: on a degraded turn stream_with_lifeboat rewrote
    model/provider_name but state["provider"] still points at the credential
    that just 401'd, so reusing it here would fail on every degraded turn.
    resolver.extractor() picks the credential that is allowed to do unasked-for
    work — never the user's paid one.
    """
    try:
        # Off the critical path on purpose: retrieval is what the user waits on
        # and it must not pay for a write.
        retriever.touch(state["user_id"], state.get("injected_ids") or [])
        if state.get("failed"):
            return
        # SKIP-GATE (the free win): extract.py grounds every item against a
        # CONTENT WORD of the user's message, so a message with none can produce
        # nothing — extraction is a provable no-op. Skip it before spending a
        # token resolving/calling the extractor. Catches "ok"/"2+2"/emoji turns.
        if not extractor_mod._words(state.get("message") or "", 3):
            _log.info("extract skipped: no content words in message")
            return
        provider = resolver.extractor(state["user_id"])
        if provider is None:
            return  # no credential may pay for this. Store nothing.
        items = extractor_mod.extract(provider, state["message"], state.get("answer", ""))
        # No token count here: the extractor uses chat(), which does not populate
        # last_usage (only stream() does), and a reused provider instance would
        # otherwise leak the ANSWER stream's count. Item count is the honest signal.
        _log.info("extract model=%s items=%d", getattr(provider, "model", "?"), len(items))
        mid = state.get("persisted_message_id")
        retriever.write_facts(state["user_id"], [i for i in items if i["kind"] == "triple"], mid)
        retriever.write_notes(state["user_id"], [i for i in items if i["kind"] == "note"], mid)
    except Exception:
        pass


def run(state: dict) -> None:
    """Run the steps in order, merging each step's partial update back into the
    shared state — the same last-value-wins channel behavior a StateGraph gave
    us, minus the graph. Output is delivered via state["emit"], so the return
    value is intentionally unused.

    Extraction is NOT here: it runs after main.py closes the stream.
    """
    state.update(context_node(state))
    state.update(generate_node(state))
    state.update(persist_node(state))
    state.update(done_node(state))
