"""tasks tool: right method+URL+body, resolvable list, honest errors, no wire-"id".

No live user-svc: httpx.request is monkeypatched to a fake that records the call
and returns a REAL httpx.Response (so raise_for_status / .json() behave exactly as
in production). Run:
  cd agent-svc && .venv/bin/python -m pytest -q tests/test_tasks_tool.py
"""
import json
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import config  # noqa: E402
from tools import tasks  # noqa: E402

UID = "u-123"
BASE = f"{config.USER_SVC_URL}/users/{UID}/tasks"


def _fake_httpx(monkeypatch, status, payload, calls):
    def fake_request(method, url, json=None, headers=None, timeout=None):
        calls.append({"method": method, "url": url, "json": json})
        return httpx.Response(status, json=payload, request=httpx.Request(method, url))

    monkeypatch.setattr(tasks.httpx, "request", fake_request)


def test_create_task_builds_post(monkeypatch):
    calls = []
    _fake_httpx(monkeypatch, 201, {"id": "t9", "title": "Buy milk"}, calls)
    out = tasks.create_task(UID, "Buy milk", due_date="2026-07-20")
    assert calls == [
        {"method": "POST", "url": BASE, "json": {"title": "Buy milk", "due_date": "2026-07-20"}}
    ]
    assert "Buy milk" in out and "t9" in out  # confirmation echoes the new task_id


def test_list_tasks_is_resolvable(monkeypatch):
    calls = []
    payload = [
        {"id": "t1", "title": "Buy milk", "status": "open", "due_date": "2026-07-21"},
        {"id": "t2", "title": "Ship it", "status": "in_progress", "due_date": None},
    ]
    _fake_httpx(monkeypatch, 200, payload, calls)
    out = tasks.list_tasks(UID)
    assert calls[0]["method"] == "GET" and calls[0]["url"] == BASE
    # A title the user names must be resolvable to its task_id, and fenced as data.
    assert "-----BEGIN USER TASKS-----" in out and "-----END USER TASKS-----" in out
    assert "task_id t1" in out and "Buy milk" in out
    assert "task_id t2" in out and "no due date" in out  # null due renders honestly


def test_update_task_builds_patch(monkeypatch):
    calls = []
    _fake_httpx(monkeypatch, 200, {"id": "t1", "title": "Buy milk", "status": "done"}, calls)
    out = tasks.update_task(UID, "t1", status="done")
    assert calls == [{"method": "PATCH", "url": f"{BASE}/t1", "json": {"status": "done"}}]
    assert "done" in out


def test_update_task_rejects_bad_status(monkeypatch):
    calls = []
    _fake_httpx(monkeypatch, 200, {}, calls)
    out = tasks.update_task(UID, "t1", status="archived")
    assert calls == []  # rejected before any I/O
    assert "open, in_progress or done" in out


def test_delete_task_builds_delete(monkeypatch):
    calls = []
    _fake_httpx(monkeypatch, 200, {"deleted": True}, calls)
    out = tasks.delete_task(UID, "t1")
    assert calls == [{"method": "DELETE", "url": f"{BASE}/t1", "json": None}]
    assert "t1" in out


def test_handler_returns_error_string_on_500(monkeypatch):
    calls = []
    _fake_httpx(monkeypatch, 500, {"error": "boom"}, calls)
    out = tasks.create_task(UID, "Buy milk")  # must NOT raise
    assert isinstance(out, str)
    assert "Could not add task" in out and "500" in out


def test_handler_returns_error_string_on_network_fail(monkeypatch):
    def boom(*a, **k):
        raise httpx.ConnectError("no route")

    monkeypatch.setattr(tasks.httpx, "request", boom)
    out = tasks.list_tasks(UID)  # must NOT raise
    assert isinstance(out, str) and "Could not list tasks" in out


def test_schemas_use_task_id_not_bare_id():
    for schema in tasks.ALL_TOOLS:
        blob = json.dumps(schema)
        # e2e.sh section 5 bans the literal "id" in persisted tool_calls.
        assert '"id"' not in blob, f'{schema["name"]} has a bare "id" key'
    # The mutating tools address a task, and they do it by task_id.
    for schema in (tasks.UPDATE_TASK, tasks.DELETE_TASK):
        assert "task_id" in schema["parameters"]["properties"]


def test_mutating_set_is_the_writes():
    assert tasks.MUTATING == {"create_task", "update_task", "delete_task"}


def test_looks_task_related_gate():
    assert tasks.looks_task_related("add buy milk to my tasks") is True
    assert tasks.looks_task_related("what's the capital of France") is False
