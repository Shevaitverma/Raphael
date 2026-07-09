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

OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434/v1")
OPENROUTER_BASE_URL = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")

# In-process embeddings — no key, no network at inference.
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "nomic-ai/nomic-embed-text-v1.5")
EMBEDDING_MODEL_NAME = "nomic-embed-text-v1.5"  # stored next to each vector
EMBEDDING_DIM = 768

ANTHROPIC_DEFAULT_MODEL = "claude-opus-4-8"
