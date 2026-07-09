# syntax=docker/dockerfile:1
# Slim production image. Excludes the OAuth adapter's claude-agent-sdk + Node —
# see Dockerfile.oauth for the variant that includes them.
FROM python:3.13-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/opt/hf \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    PYTHONPATH=/app/src

WORKDIR /app

# CPU-only torch FIRST so sentence-transformers doesn't drag in ~2GB of CUDA.
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch

COPY requirements.txt .
RUN pip install -r requirements.txt

# Bake the encoder weights into the image. plan.md wants the encoder warm at
# boot, not fetched on first request — here we go one better and fetch at BUILD,
# so cold start does zero network I/O. HF_HUB_OFFLINE above then forbids any
# accidental runtime download.
RUN HF_HUB_OFFLINE=0 TRANSFORMERS_OFFLINE=0 python -c \
    "from sentence_transformers import SentenceTransformer; \
     SentenceTransformer('nomic-ai/nomic-embed-text-v1.5', trust_remote_code=True)"

COPY src ./src

# Non-root.
RUN useradd -m -u 10001 app && chown -R app:app /opt/hf /app
USER app

EXPOSE 8000
# Liveness for orchestration (works once the DB is reachable).
HEALTHCHECK --interval=10s --timeout=3s --start-period=40s --retries=6 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/healthz')" || exit 1

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--app-dir", "src"]
