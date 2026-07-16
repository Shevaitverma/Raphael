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
EMBEDDING_DIM = 768

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
