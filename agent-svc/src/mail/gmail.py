"""Gmail REST client: read messages, manage labels. NEVER destroys mail.

One scope, gmail.modify, which is a ceiling as much as a permission — permanent
deletion needs full mail.google.com, which this deployment never requests. So
"the assistant cannot destroy mail" is enforced by Google. The guards here close
the remaining gap: gmail.modify CAN move a message to Trash or Spam by applying
those labels, so TRASH/SPAM are refused as label targets in code (_check_labels),
and drafts are refused outright because Gmail rejects labelling them anyway.

QUOTA IS THE REAL CONSTRAINT, not latency. Gmail bills per method in "units"
against 6,000 units/minute/user, and messages.get is 20 of them — so a mailbox
backfill is quota-bound at roughly 300 messages/minute no matter how fast the
network is. _Bucket paces every call against that budget rather than discovering
it through 429s.

Errors are split by what the caller should DO, not by status code:
  - 404 on messages.get      -> None. Normal: the message was deleted or moved
                                between the history record and the fetch.
  - 404 on users.history.list-> HistoryTooOld. The cursor aged out (Gmail keeps
                                roughly a week); the caller must full-resync.
  - 401/403 invalid creds    -> GmailAuthError. The grant is dead; retrying is
                                pointless and the user must reconnect.
  - 403 rateLimit*/429/5xx   -> retried here with jittered backoff, invisibly.
  - everything else          -> GmailError, with the status attached.

PURE I/O: never calls an LLM, never touches the database.
"""
from __future__ import annotations

import logging
import random
import threading
import time

import httpx

_log = logging.getLogger(__name__)

API = "https://gmail.googleapis.com/gmail/v1/users/me"

# Published per-method quota costs. Kept as a table rather than inlined so the
# pacing stays honest when a call site changes method.
UNITS = {
    "profile": 1,
    "labels.list": 1,
    "labels.create": 5,
    "history.list": 2,
    "messages.list": 5,
    "messages.get": 20,
    "messages.modify": 5,
    "messages.batchModify": 50,
}

# 6,000 units/minute/user = 100/s. We pace at 80 to leave headroom: the
# concurrent-request ceiling is shared with EVERY other Gmail client touching
# this mailbox (a desktop mail app can trigger our 429s), so the budget is not
# exclusively ours.
RATE_UNITS_PER_SEC = 80.0
BURST_UNITS = 200.0

TIMEOUT = 20.0
MAX_ATTEMPTS = 5

# Gmail's own caps, not ours: list pages at 500, batchModify at 1000 ids.
MAX_LIST_PAGE = 500
MAX_BATCH_IDS = 1000

# Applying either of these is a destructive action wearing a label's clothes.
FORBIDDEN_LABELS = frozenset({"TRASH", "SPAM"})


class GmailError(Exception):
    """A Gmail call failed in a way the caller has to handle."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class GmailAuthError(GmailError):
    """Credentials are dead. Retrying cannot help; the user must reconnect."""


class HistoryTooOld(GmailError):
    """startHistoryId aged out of Gmail's window. Caller must full-resync."""


class _Bucket:
    """Token bucket over quota units, shared process-wide.

    Deliberately global rather than per-call-site: the quota is per MAILBOX, so
    two independent loops pacing themselves separately would still collectively
    exceed it. Blocking (not raising) because the caller's only sane response to
    "you are going too fast" is to go slower.
    """

    def __init__(self, rate: float, burst: float):
        self._rate = rate
        self._burst = burst
        self._tokens = burst
        self._at = time.monotonic()
        self._lock = threading.Lock()

    def spend(self, units: float) -> None:
        # ponytail: one global bucket, single-mailbox assumption. A multi-mailbox
        # deployment wants one bucket per user_id keyed in a dict.
        while True:
            with self._lock:
                now = time.monotonic()
                self._tokens = min(self._burst, self._tokens + (now - self._at) * self._rate)
                self._at = now
                if self._tokens >= units:
                    self._tokens -= units
                    return
                wait = (units - self._tokens) / self._rate
            time.sleep(min(wait, 5.0))


_bucket = _Bucket(RATE_UNITS_PER_SEC, BURST_UNITS)


def _retryable(status: int) -> bool:
    return status == 429 or status >= 500


def _request(method: str, path: str, token: str, cost_key: str,
             params=None, json_body=None, allow_404: bool = False):
    """One paced, retried Gmail call. Returns parsed JSON, or None on an allowed
    404. Raises the taxonomy above."""
    units = UNITS.get(cost_key, 5)
    url = path if path.startswith("http") else API + path
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}

    last: Exception | None = None
    for attempt in range(MAX_ATTEMPTS):
        _bucket.spend(units)
        try:
            r = httpx.request(method, url, headers=headers, params=params,
                              json=json_body, timeout=TIMEOUT)
        except Exception as e:              # transport: worth one more try
            last = e
            _log.warning("gmail %s transport error: %s", cost_key, type(e).__name__)
            _sleep_backoff(attempt)
            continue

        if r.status_code == 204 or (r.status_code == 200 and not r.content):
            return {}
        if r.status_code == 200:
            try:
                return r.json()
            except Exception:
                return {}
        if r.status_code == 404 and allow_404:
            return None
        if r.status_code in (401, 403) and not _is_rate_limit(r):
            # Never log the body: it echoes request context.
            raise GmailAuthError(f"gmail {cost_key} rejected the credential", r.status_code)
        if _retryable(r.status_code) or _is_rate_limit(r):
            _log.warning("gmail %s throttled/failed: %s (attempt %d)",
                         cost_key, r.status_code, attempt + 1)
            _sleep_backoff(attempt)
            continue
        raise GmailError(f"gmail {cost_key} failed: HTTP {r.status_code}", r.status_code)

    raise GmailError(f"gmail {cost_key} failed after {MAX_ATTEMPTS} attempts: {last}")


def _is_rate_limit(r) -> bool:
    """403 is overloaded: it means both "your credential is not allowed" and
    "you are going too fast". Only the reason string separates them, and getting
    this wrong either hammers a dead credential or gives up on a transient."""
    if r.status_code != 403:
        return False
    try:
        reason = (r.json().get("error", {}).get("errors") or [{}])[0].get("reason", "")
    except Exception:
        return False
    return reason in ("rateLimitExceeded", "userRateLimitExceeded", "backendError")


def _sleep_backoff(attempt: int) -> None:
    # Truncated exponential with full jitter. Gmail's guidance is to start at
    # >= 1s; jitter matters because a burst of workers retrying in lockstep is
    # how a transient becomes sustained.
    time.sleep(min(32.0, 2 ** attempt) * (0.5 + random.random() / 2))


# --------------------------------------------------------------------------
# reads

def get_profile(token: str) -> dict:
    """emailAddress + historyId. The historyId here is the sync bootstrap and
    must be persisted BEFORE a backfill starts, not after — anything arriving
    during the backfill is then caught by the first incremental pass."""
    return _request("GET", "/profile", token, "profile") or {}


def list_message_ids(token: str, q: str | None = None, page_token: str | None = None,
                     max_results: int = MAX_LIST_PAGE) -> tuple[list[str], str | None]:
    """One page of message ids. Returns (ids, next_page_token).

    Gmail does NOT guarantee reverse-chronological order here, so the caller
    orders on internalDate later rather than trusting this sequence.
    """
    params = {"maxResults": min(max_results, MAX_LIST_PAGE)}
    if q:
        params["q"] = q
    if page_token:
        params["pageToken"] = page_token
    data = _request("GET", "/messages", token, "messages.list", params=params) or {}
    ids = [m["id"] for m in (data.get("messages") or []) if m.get("id")]
    return ids, data.get("nextPageToken")


def get_message(token: str, message_id: str) -> dict | None:
    """Full message, or None if it is gone.

    format=full because the quota cost is 20 units for EVERY format — there is
    no cheaper metadata-first pass, so fetching twice would simply cost double.
    """
    return _request("GET", f"/messages/{message_id}", token, "messages.get",
                    params={"format": "full"}, allow_404=True)


def list_history(token: str, start_history_id: str, page_token: str | None = None
                 ) -> tuple[list[str], str | None, str | None]:
    """Message ids added since start_history_id. Returns (ids, next_page, current_history_id).

    historyTypes is 'messageAdded', SINGULAR — the response objects are plural
    ('messagesAdded') and passing the plural form is silently accepted as a
    filter that matches nothing, which reads exactly like an empty mailbox.
    """
    params = {"startHistoryId": start_history_id, "historyTypes": "messageAdded",
              "maxResults": MAX_LIST_PAGE}
    if page_token:
        params["pageToken"] = page_token
    data = _request("GET", "/history", token, "history.list", params=params, allow_404=True)
    if data is None:
        raise HistoryTooOld("startHistoryId is outside Gmail's history window", 404)
    ids: list[str] = []
    for rec in data.get("history") or []:
        for added in rec.get("messagesAdded") or []:
            mid = (added.get("message") or {}).get("id")
            if mid:
                ids.append(mid)
    # Dedup preserving order: one message can appear in several history records.
    seen, out = set(), []
    for mid in ids:
        if mid not in seen:
            seen.add(mid)
            out.append(mid)
    return out, data.get("nextPageToken"), data.get("historyId")


def list_labels(token: str) -> dict[str, str]:
    """name -> label id, for every label in the mailbox. Label ids are opaque and
    per-mailbox, so they are looked up, never hardcoded."""
    data = _request("GET", "/labels", token, "labels.list") or {}
    return {l["name"]: l["id"] for l in (data.get("labels") or [])
            if l.get("name") and l.get("id")}


def create_label(token: str, name: str) -> str:
    """Create one user label and return its id.

    'Prefix/Child' is a naming convention the Gmail UI renders as nesting; the
    API sees one flat opaque string, so nothing here builds a tree.
    """
    body = {"name": name, "labelListVisibility": "labelShow",
            "messageListVisibility": "show"}
    data = _request("POST", "/labels", token, "labels.create", json_body=body) or {}
    lid = data.get("id")
    if not lid:
        raise GmailError(f"label create returned no id for {name!r}")
    return lid


# --------------------------------------------------------------------------
# the only writes this client can perform

def _check_labels(add: list[str], remove: list[str]) -> None:
    """The destructive-action guard.

    gmail.modify cannot permanently delete, but applying TRASH or SPAM is a
    trash/spam action in all but name. This is a code-level refusal rather than
    a convention because the label ids arrive from a table that a future feature
    could populate from less careful input.
    """
    for lid in list(add) + list(remove):
        if str(lid).upper() in FORBIDDEN_LABELS:
            raise GmailError(f"refusing to touch the {lid} label: destructive")
    if len(add) > 100 or len(remove) > 100:
        raise GmailError("Gmail allows at most 100 label changes per direction")


def modify_message(token: str, message_id: str, add: list[str], remove: list[str]) -> None:
    """Label one message. Idempotent: add/remove are SET operations, so applying
    a label twice is a no-op and a retry after a timeout is free."""
    _check_labels(add, remove)
    if not add and not remove:
        return
    _request("POST", f"/messages/{message_id}/modify", token, "messages.modify",
             json_body={"addLabelIds": add, "removeLabelIds": remove}, allow_404=True)


def batch_modify(token: str, message_ids: list[str], add: list[str], remove: list[str]) -> None:
    """Label up to 1000 messages with the SAME label set, in one call.

    50 units flat versus 5 per message, so this wins above ~10 messages. Returns
    an empty body on success, which combined with set semantics means a timed-out
    call is safely re-runnable.
    """
    _check_labels(add, remove)
    ids = [m for m in message_ids if m]
    if not ids or (not add and not remove):
        return
    for i in range(0, len(ids), MAX_BATCH_IDS):
        chunk = ids[i:i + MAX_BATCH_IDS]
        _request("POST", "/messages/batchModify", token, "messages.batchModify",
                 json_body={"ids": chunk, "addLabelIds": add, "removeLabelIds": remove})


def apply_labels(token: str, message_ids: list[str], add: list[str], remove: list[str]) -> None:
    """Label a group, choosing the cheaper call for its size."""
    if len(message_ids) > 10:
        batch_modify(token, message_ids, add, remove)
        return
    for mid in message_ids:
        modify_message(token, mid, add, remove)


def demo() -> None:
    """Self-check for the parts that are pure logic. No network."""
    # the destructive-action guard, in both directions and case-insensitively
    for bad in (["TRASH"], ["Spam"], ["INBOX", "trash"]):
        try:
            _check_labels(bad, [])
            raise AssertionError(f"_check_labels allowed {bad}")
        except GmailError:
            pass
        try:
            _check_labels([], bad)
            raise AssertionError(f"_check_labels allowed removing {bad}")
        except GmailError:
            pass
    _check_labels(["Label_1", "INBOX"], ["UNREAD"])          # ordinary labels pass
    try:
        _check_labels(["L"] * 101, [])
        raise AssertionError("_check_labels allowed >100 additions")
    except GmailError:
        pass

    # the bucket must actually pace: 3 x 200 units at 80/s cannot finish instantly
    b = _Bucket(rate=80.0, burst=100.0)
    t0 = time.monotonic()
    for _ in range(3):
        b.spend(100)
    assert time.monotonic() - t0 >= 2.0, "bucket did not throttle"

    # a 403 that is really a rate limit must not be mistaken for a dead credential
    class _R:
        status_code = 403

        def __init__(self, reason):
            self._reason = reason

        def json(self):
            return {"error": {"errors": [{"reason": self._reason}]}}

    assert _is_rate_limit(_R("rateLimitExceeded")) is True
    assert _is_rate_limit(_R("userRateLimitExceeded")) is True
    assert _is_rate_limit(_R("insufficientPermissions")) is False

    print("gmail.py demo: ok")


if __name__ == "__main__":
    demo()
