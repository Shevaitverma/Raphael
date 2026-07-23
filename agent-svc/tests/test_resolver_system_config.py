"""Provider resolution is SYSTEM-WIDE, calendar stays per-user.

The one thing that must never silently regress: chat/lifeboat/extractor resolve
the seeded system-config owner's credentials, NOT the caller's. google_token
must stay per-user (each member connects their own calendar). We monkeypatch the
HTTP layer (_get) and assert the path each function builds. No network, no DB.
"""
import config

# Resilient to the sibling that adds SYSTEM_CONFIG_UID to config: if it is not
# there yet, seed the agreed sentinel so this test runs standalone. Once the real
# constant lands, hasattr is true and its value is used verbatim.
if not hasattr(config, "SYSTEM_CONFIG_UID"):
    config.SYSTEM_CONFIG_UID = "00000000-0000-0000-0000-000000000002"

from config import SYSTEM_CONFIG_UID  # noqa: E402
from llm import resolver  # noqa: E402

CALLER = "11111111-1111-1111-1111-111111111111"


def test_active_targets_system_owner(monkeypatch):
    seen = {}
    monkeypatch.setattr(resolver, "_get", lambda path: seen.update(path=path))
    resolver._fetch_active(CALLER)
    assert seen["path"] == f"/internal/users/{SYSTEM_CONFIG_UID}/credential/active"
    assert CALLER not in seen["path"]  # caller uid must NOT drive provider selection


def test_lifeboat_targets_system_owner(monkeypatch):
    seen = {}
    monkeypatch.setattr(resolver, "_get", lambda path: seen.update(path=path))
    resolver._fetch_lifeboat(CALLER)
    assert seen["path"] == f"/internal/users/{SYSTEM_CONFIG_UID}/credential/lifeboat"


def test_google_token_stays_per_user(monkeypatch):
    seen = {}
    monkeypatch.setattr(resolver, "_get", lambda path: seen.update(path=path) or {"access_token": "t"})
    resolver.google_token(CALLER)
    assert seen["path"] == f"/internal/users/{CALLER}/google/token"  # calendar is per-member
