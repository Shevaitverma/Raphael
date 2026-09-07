"""Environment-derived constants.

We read only real process environment variables (os.environ). We NEVER read a
.env file and never print a secret value. Defaults match docs/CONTRACT.md and
.env.example (Postgres on 5433, Ollama on 11434).
"""
from __future__ import annotations
import os

DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql://raphael:raphael@localhost:5433/raphael"
)
USER_SVC_URL = os.environ.get("USER_SVC_URL", "http://localhost:8081")
CONV_SVC_URL = os.environ.get("CONV_SVC_URL", "http://localhost:8082")

# Shared secret for user-svc /internal/* (which returns decrypted keys). Must
# match user-svc's INTERNAL_TOKEN. No default — an empty value means the
# resolver cannot fetch credentials, which fails loudly rather than silently.
INTERNAL_TOKEN = os.environ.get("INTERNAL_TOKEN", "")

# The user row that owns the system-wide provider config; must match the
# gateway/db seed (SYSTEM_CONFIG_UID). The resolver fetches provider credentials
# under THIS uid for every caller (config is admin-owned & system-wide), while
# per-user google_token stays keyed by each member's own uid.
SYSTEM_CONFIG_UID = os.environ.get(
    "SYSTEM_CONFIG_UID", "00000000-0000-0000-0000-000000000002"
)

OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434/v1")

# The SERVED context window is min(what the model was trained for, num_ctx the
# server actually allocates). /api/tags happily says 262144 while the server
# quietly truncates to num_ctx and never errors. /api/ps does report the served
# context_length — but only for models already LOADED, and it returns
# {"models":[]} when nothing is, which is exactly when we discover capabilities.
# So the knob is the authority. This is the calibration knob: set it to match the
# num_ctx your Ollama is really running (Modelfile / OLLAMA_CONTEXT_LENGTH).
# Under-claiming truncates nothing; over-claiming truncates in silence.
OLLAMA_NUM_CTX = int(os.environ.get("OLLAMA_NUM_CTX", "4096"))
OPENROUTER_BASE_URL = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")

# In-process embeddings — no key, no network at inference.
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "nomic-ai/nomic-embed-text-v1.5")
EMBEDDING_MODEL_NAME = "nomic-embed-text-v1.5"  # stored next to each vector

ANTHROPIC_DEFAULT_MODEL = "claude-opus-4-8"

# Web search. Operator deployment config, not a per-user credential: it has no
# model, cannot stream, and must never be a lifeboat. None = feature off — the
# tool is never registered and nothing leaves the box. SEARCH_BASE_URL is the
# entire egress surface; point it at a self-hosted SearxNG to keep egress local.
# `or None`: set-but-empty is how .env.example ships it and how `set -a; . .env`
# exports it, and '' must mean off, not "a key I have".
SEARCH_API_KEY = os.environ.get("BRAVE_API_KEY") or None
SEARCH_BASE_URL = os.environ.get(
    "SEARCH_BASE_URL", "https://api.search.brave.com/res/v1/web/search"
)

# ---- mail intelligence ----------------------------------------------------
# Off by default: MAIL_ENABLED gates the worker thread entirely, and each user
# additionally opts in via mail_config.enabled. Empty/false = the thread never
# starts, no Gmail call is ever made, and the feature costs nothing.
MAIL_ENABLED = (os.environ.get("MAIL_ENABLED", "") or "").lower() in ("1", "true", "yes")

# How often the worker wakes. 5 minutes, not the hour the brief assumed:
# users.history.list costs 2 quota units against 6,000 units/MINUTE, so
# 5-minutely spends ~576 units/day — hourly buys nothing but latency.
MAIL_POLL_SECONDS = int(os.environ.get("MAIL_POLL_SECONDS", "300"))

# How far back the one-time import reaches, and how much it chews per tick.
# Bounded per tick so the backfill shares the box with everything else rather
# than monopolising the model for three hours.
MAIL_BACKFILL_DAYS = int(os.environ.get("MAIL_BACKFILL_DAYS", "90"))
MAIL_BATCH_SIZE = int(os.environ.get("MAIL_BATCH_SIZE", "25"))

# Gmail label namespace. Configurable so the labels carry no project name.
MAIL_LABEL_PREFIX = os.environ.get("MAIL_LABEL_PREFIX", "Assistant")

# Optional pin for the classifier model. Empty = use whatever the resolved local
# credential specifies, which keeps one source of truth for model choice.
MAIL_MODEL = os.environ.get("MAIL_MODEL") or None

# THE PRIVACY SWITCH. False (the default) means classification resolves a LOCAL
# provider or does not happen at all — email bodies never reach a cloud API.
# Turning it on is a deliberate, logged decision, not a fallback the system can
# take by itself when the local model is down. The lifeboat is deliberately NOT
# consulted for mail: it exists to keep CHAT alive on a dead paid credential and
# is designed to be a cloud provider, which is exactly wrong here.
MAIL_ALLOW_CLOUD_CLASSIFIER = (
    os.environ.get("MAIL_ALLOW_CLOUD_CLASSIFIER", "") or ""
).lower() in ("1", "true", "yes")
