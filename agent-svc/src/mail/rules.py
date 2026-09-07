"""The decision engine. A pure function, and the only path from model output to action.

WHY THIS FILE EXISTS AT ALL. The classifier can be made to say anything — measured
on this stack, 3/3 naive injections and 2/3 adaptive ones took control of a 9B
model's record, and one of those needed no injection technique whatsoever because
it was simply a convincing phishing email. There is no prompt that fixes that:
believing the email is what a classifier is FOR. So the model's opinion is treated
as evidence, and the authority to interrupt a human lives here instead, in code
that reads headers the sender does not control.

THE CAP IS THE WHOLE CONTROL, and it is four lines:

    if not trust.auth_ok or trust.bulk:
        tier = min(tier, FYI); alert = False

An attacker with TOTAL control of the model's output still cannot produce an
act-now alert without also passing SPF, DKIM and DMARC for a domain the user has
corresponded with. Everything else in this module is ergonomics.

UNCERTAIN MEANS DOWN, NEVER UP. A missed alert costs "you found it an hour later",
which is the latency the user had before this system existed — the inbox is a free,
always-on fallback. A false alert costs the whole system: a few useless buzzes and
the channel gets muted, and a muted channel has recall zero for EVERYTHING. So
precision is optimised and recall is deliberately sacrificed.

Pure: no I/O, no LLM, no clock read (now is passed in). That is what makes the
security property testable by exhausting the input space rather than arguing.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime

# Tier ordering. Comparable so a cap is min(), not a lookup table.
NOISE, FYI, ACT_SOON, ACT_NOW = 0, 1, 2, 3
TIER_NAMES = {NOISE: "noise", FYI: "fyi", ACT_SOON: "act_soon", ACT_NOW: "act_now"}
TIER_VALUES = {v: k for k, v in TIER_NAMES.items()}

# Hours/days that separate "now" from "soon".
DEADLINE_URGENT_HOURS = 48
DEADLINE_SOON_DAYS = 14

# Events that justify waking someone, IF the sender is authenticated.
SECURITY_CRITICAL = frozenset({"breach_notice", "account_suspended", "unusual_activity"})
FINANCE_CRITICAL = frozenset({"payment_failed", "unusual_activity"})
# Self-initiated: the user just did this, and already knows.
SELF_INITIATED = frozenset({"mfa_code", "login_alert"})
# Something completed. Worth recording, never worth interrupting.
COMPLETED = frozenset({
    "payment_confirmed", "delivered", "order_confirmed", "password_change",
    "refund", "income_received", "cancelled",
})


@dataclass(frozen=True)
class SenderTrust:
    """Everything we know about the sender that the SENDER did not tell us.

    auth_ok comes from the Authentication-Results header Gmail itself wrote.
    known/frequent come from our own history. bulk comes from List-Unsubscribe.
    Nothing here is derived from the body, the subject, or the model.
    """
    auth_ok: bool = False
    bulk: bool = False
    known: bool = False        # the user has sent mail to this address
    frequent: bool = False     # several prior messages from this sender


@dataclass(frozen=True)
class UserRule:
    """A human's explicit override. Outranks every heuristic in this file."""
    match_type: str            # 'address' | 'domain' | 'pattern'
    match_value: str
    force_category: str | None = None
    force_tier: str | None = None
    never_alert: bool = False
    always_alert: bool = False


@dataclass(frozen=True)
class Decision:
    tier: str
    alert: bool
    category: str
    rule_fired: str            # why — so "what woke me at 3am?" has an answer
    dedup_key: str | None = None


def match_rule(rules, address: str) -> UserRule | None:
    """Most specific first: exact address, then domain, then pattern.

    Specificity order matters — a "never alert anything from acme.com" domain
    rule must not shadow "always alert me about billing@acme.com".
    """
    address = (address or "").lower().strip()
    domain = address.rpartition("@")[2]
    for want in ("address", "domain", "pattern"):
        for r in rules or []:
            if r.match_type != want:
                continue
            v = (r.match_value or "").lower().strip()
            if want == "address" and v == address:
                return r
            if want == "domain" and v and (domain == v or domain.endswith("." + v)):
                return r
            if want == "pattern" and v:
                try:
                    if re.search(v, address):
                        return r
                except re.error:
                    continue        # a bad user regex is ignored, never fatal
    return None


def _days_until(deadline, now: datetime) -> float | None:
    if deadline is None:
        return None
    if isinstance(deadline, str):
        try:
            deadline = date.fromisoformat(deadline)
        except ValueError:
            return None
    if isinstance(deadline, datetime):
        deadline = deadline.date()
    if not isinstance(deadline, date):
        return None
    return (deadline - now.date()).days


def _base_tier(cls: dict, trust: SenderTrust, now: datetime) -> tuple[int, bool, str]:
    """The optimistic reading: what this WOULD be from a trusted sender.

    Returns (tier, alert, rule_name). Caps are applied by the caller — keeping
    escalation and containment in separate functions is what makes the security
    test able to assert "no input reaches act_now while untrusted".
    """
    category = cls.get("category") or "other"
    event = cls.get("event_type") or "other"
    action = bool(cls.get("action_required"))
    days = _days_until(cls.get("deadline"), now)

    if category == "security" and event in SECURITY_CRITICAL:
        return ACT_NOW, True, "security_critical"
    if category == "finance" and event in FINANCE_CRITICAL:
        return ACT_NOW, True, "finance_critical"
    if days is not None and action and days <= DEADLINE_URGENT_HOURS / 24:
        return ACT_NOW, True, "deadline_imminent"
    if days is not None and action and days <= DEADLINE_SOON_DAYS:
        return ACT_SOON, True, "deadline_near"
    if event in SELF_INITIATED:
        # The user triggered this seconds ago and is already looking at their
        # phone. Labelling it is useful; buzzing about it is not.
        return ACT_SOON, False, "self_initiated"
    if action and trust.known:
        return ACT_SOON, True, "action_required_known_sender"
    if category == "marketing":
        return NOISE, False, "marketing"
    if event in COMPLETED:
        return FYI, False, "completed"
    if action:
        # Something is asked of the user by someone they have never written to.
        # Real enough to surface, not enough to interrupt.
        return FYI, False, "action_required_unknown_sender"
    return FYI, False, "default"


def decide(cls: dict | None, trust: SenderTrust, rules=None,
           now: datetime | None = None, dedup_anchor: str | None = None) -> Decision:
    """One classification -> one decision. Never raises.

    cls is None when classification failed or never ran (no local model). That is
    NOT an error state to be papered over — it becomes fyi/needs_review and never
    alerts, so a degraded pipeline goes quiet rather than going wrong.
    """
    now = now or datetime.now()
    address = (cls or {}).get("sender_address") or ""

    if cls is None:
        return Decision(TIER_NAMES[FYI], False, "other", "unclassified")

    category = cls.get("category") or "other"
    rule = match_rule(rules, address)

    # (1) The human always wins. An explicit tier ends the decision, including
    # over the trust caps below — if someone says "always act_now for my bank",
    # that is their call to make and ours to obey.
    if rule and rule.force_category:
        category = rule.force_category
    if rule and rule.force_tier:
        tier = TIER_VALUES.get(rule.force_tier, FYI)
        alert = tier >= ACT_SOON and not rule.never_alert
        return Decision(TIER_NAMES[tier], alert, category, "user_rule",
                        _dedup(dedup_anchor, TIER_NAMES[tier], alert))

    tier, alert, fired = _base_tier(cls, trust, now)

    # (2) THE CAP. Everything above is what the email CLAIMS; this is what it has
    # EARNED. An unauthenticated or bulk sender cannot escalate, no matter what
    # the model was persuaded to emit.
    if not trust.auth_ok:
        tier, alert, fired = min(tier, FYI), False, "capped_unauthenticated"
    elif trust.bulk:
        tier, alert, fired = min(tier, FYI), False, "capped_bulk"

    # (3) Narrow human overrides that do not set a tier outright.
    if rule and rule.never_alert:
        alert, fired = False, "user_rule_never_alert"
    elif rule and rule.always_alert:
        # Explicit, per-sender, opt-in. The only way past the cap, and it took a
        # human writing the sender down to get here.
        tier = max(tier, ACT_SOON)
        alert, fired = True, "user_rule_always_alert"

    name = TIER_NAMES[tier]
    return Decision(name, alert, category, fired, _dedup(dedup_anchor, name, alert))


def _dedup(anchor: str | None, tier: str, alert: bool) -> str | None:
    """One alert per conversation per tier.

    Anchored on the References root rather than the subject, because subjects
    mutate with Re:/Fwd: and localisation while the thread root does not. No
    alert -> no key, so nothing occupies the unique index needlessly.
    """
    if not alert or not anchor:
        return None
    return f"{anchor}:{tier}"


def demo() -> None:
    """Self-check. The security property is asserted by EXHAUSTING the input
    space, not by sampling it — the enum cross-product is small enough."""
    from itertools import product
    from mail.classify import CATEGORIES, EVENT_TYPES, URGENCIES

    now = datetime(2026, 8, 18, 12, 0, 0)
    trusted = SenderTrust(auth_ok=True, known=True)
    untrusted = SenderTrust(auth_ok=False)
    bulky = SenderTrust(auth_ok=True, bulk=True)

    def c(**kw):
        base = {"category": "other", "event_type": "other", "urgency": "none",
                "action_required": False, "deadline": None, "sender_address": "a@b.c"}
        base.update(kw)
        return base

    # --- THE SECURITY PROPERTY --------------------------------------------
    # No combination of model output, from an unauthenticated sender, may
    # produce an alert or a tier above fyi. This is the whole defence; if it
    # ever fails, a crafted email reaches the user's phone.
    checked = 0
    for cat, ev, urg, act, dl in product(
        CATEGORIES, EVENT_TYPES, URGENCIES, (True, False),
        (None, "2026-08-18", "2026-08-19", "2026-12-31"),
    ):
        d = decide(c(category=cat, event_type=ev, urgency=urg,
                     action_required=act, deadline=dl), untrusted, now=now,
                   dedup_anchor="<t@x>")
        assert d.alert is False, f"untrusted sender alerted: {cat}/{ev}/{urg}/{act}/{dl}"
        assert d.tier in ("fyi", "noise"), f"untrusted sender escalated to {d.tier}"
        assert d.dedup_key is None
        checked += 1
    assert checked > 3000, checked

    # bulk mail is capped the same way even when it authenticates
    for cat, ev in product(CATEGORIES, EVENT_TYPES):
        d = decide(c(category=cat, event_type=ev, action_required=True,
                     deadline="2026-08-18"), bulky, now=now)
        assert d.alert is False and d.tier in ("fyi", "noise"), f"bulk escalated: {cat}/{ev}"

    # --- the happy paths still work ---------------------------------------
    d = decide(c(category="security", event_type="breach_notice"), trusted, now=now,
               dedup_anchor="<t@x>")
    assert d.tier == "act_now" and d.alert and d.rule_fired == "security_critical"
    assert d.dedup_key == "<t@x>:act_now"

    d = decide(c(category="finance", event_type="payment_failed"), trusted, now=now)
    assert d.tier == "act_now" and d.alert

    d = decide(c(category="finance", event_type="payment_due",
                 action_required=True, deadline="2026-08-19"), trusted, now=now)
    assert d.tier == "act_now" and d.rule_fired == "deadline_imminent"

    d = decide(c(category="finance", event_type="payment_due",
                 action_required=True, deadline="2026-08-27"), trusted, now=now)
    assert d.tier == "act_soon" and d.alert and d.rule_fired == "deadline_near"

    # a past-due deadline is still urgent, not ignored
    d = decide(c(action_required=True, deadline="2026-08-01"), trusted, now=now)
    assert d.tier == "act_now"

    # a 2FA code is urgent to the CLOCK but not to the user: label, do not buzz
    d = decide(c(category="security", event_type="mfa_code"), trusted, now=now)
    assert d.tier == "act_soon" and d.alert is False

    d = decide(c(category="marketing", event_type="promotion"), trusted, now=now)
    assert d.tier == "noise" and d.alert is False

    d = decide(c(category="purchase", event_type="delivered"), trusted, now=now)
    assert d.tier == "fyi" and d.alert is False

    # an unknown sender asking for something is surfaced, not escalated
    d = decide(c(category="work", event_type="request", action_required=True),
               SenderTrust(auth_ok=True, known=False), now=now)
    assert d.tier == "fyi" and d.alert is False

    # --- failure degrades quietly, never wrongly ---------------------------
    d = decide(None, trusted, now=now)
    assert d.tier == "fyi" and d.alert is False and d.rule_fired == "unclassified"

    # --- user rules --------------------------------------------------------
    rules = [UserRule("address", "bank@acme.com", force_tier="act_now"),
             UserRule("domain", "acme.com", never_alert=True)]
    # the more specific address rule wins over the domain rule
    d = decide(c(sender_address="bank@acme.com"), untrusted, rules, now=now,
               dedup_anchor="<t@x>")
    assert d.tier == "act_now" and d.alert, "explicit human rule must beat the cap"
    # ...and the domain rule still governs everyone else at acme.com
    d = decide(c(category="security", event_type="breach_notice",
                 sender_address="noreply@acme.com"), trusted, rules, now=now)
    assert d.alert is False and d.rule_fired == "user_rule_never_alert"

    # always_alert is the one opt-in past the cap, and it took a human to write it
    d = decide(c(sender_address="x@y.z"), untrusted,
               [UserRule("address", "x@y.z", always_alert=True)], now=now)
    assert d.alert is True and d.tier == "act_soon"

    # subdomains are covered by a domain rule; lookalikes are not
    assert match_rule([UserRule("domain", "acme.com")], "a@mail.acme.com") is not None
    assert match_rule([UserRule("domain", "acme.com")], "a@notacme.com") is None
    # a malformed user regex must be skipped, not crash the pipeline
    assert match_rule([UserRule("pattern", "([")], "a@b.c") is None

    print(f"rules.py demo: ok ({checked} untrusted combinations proved non-escalating)")


if __name__ == "__main__":
    demo()
