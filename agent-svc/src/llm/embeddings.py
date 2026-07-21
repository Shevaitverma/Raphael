"""In-process embeddings.

sentence-transformers loading nomic-ai/nomic-embed-text-v1.5, 768 dims, CPU,
trust_remote_code (required by that model). Warmed once at FastAPI startup so
the first request never pays the load cost. It takes no key and makes no
network call at inference time.

This is deliberately the ONLY embedding path. Claude has no /v1/embeddings
endpoint, so embeddings are never routed to a chat provider — losing a chat
credential must never cost the user their memory.
"""
from __future__ import annotations
import threading

from config import EMBEDDING_MODEL, EMBEDDING_MODEL_NAME

_encoder = None
_lock = threading.Lock()


class LocalEmbeddingProvider:
    """EmbeddingProvider over an already-loaded SentenceTransformer."""

    model_name = EMBEDDING_MODEL_NAME

    def __init__(self, model):
        self._model = model

    def embed(self, texts, prefix: str = "search_document: ") -> list:
        """nomic-embed-text-v1.5 was TRAINED with task instruction prefixes:
        'search_document: ' on stored content, 'search_query: ' on queries.
        They are what make asymmetric search work — omitting them degrades
        retrieval. Default is the storage prefix; queries must pass
        prefix="search_query: ".
        """
        vecs = self._model.encode(
            [prefix + t for t in texts],
            convert_to_numpy=True,
            normalize_embeddings=True,
        )
        return [[float(x) for x in row] for row in vecs]


def warm() -> LocalEmbeddingProvider:
    """Load the encoder if it isn't loaded yet. Safe to call repeatedly."""
    global _encoder
    if _encoder is None:
        with _lock:
            if _encoder is None:
                # Imported lazily so modules that never embed stay light.
                from sentence_transformers import SentenceTransformer

                model = SentenceTransformer(
                    EMBEDDING_MODEL, trust_remote_code=True, device="cpu"
                )
                _encoder = LocalEmbeddingProvider(model)
    return _encoder


def get_encoder() -> LocalEmbeddingProvider:
    return _encoder if _encoder is not None else warm()


def is_warm() -> bool:
    return _encoder is not None
