import pytest

from llm import resolver
from llm.anthropic_api import AnthropicAPIProvider
from llm.anthropic_cli import AnthropicCLIProvider
from llm.openai_compat import OpenAICompatProvider


def test_map_anthropic_api_key():
    p = resolver.build_provider(
        {"provider": "anthropic", "auth_type": "api_key", "api_key": "sk-x", "model_id": "claude-opus-4-8"}
    )
    assert isinstance(p, AnthropicAPIProvider)
    assert p.provider == "anthropic"


def test_map_anthropic_oauth():
    p = resolver.build_provider(
        {"provider": "anthropic", "auth_type": "oauth", "api_key": "tok", "model_id": "claude-opus-4-8"}
    )
    assert isinstance(p, AnthropicCLIProvider)


def test_map_openai_compat_openrouter():
    p = resolver.build_provider(
        {
            "provider": "openai_compat",
            "auth_type": "api_key",
            "api_key": "or-x",
            "base_url": "https://openrouter.ai/api/v1",
            "model_id": "x/y",
        }
    )
    assert isinstance(p, OpenAICompatProvider)
    assert p.provider == "openai_compat"
    assert p.backend == "openrouter"


def test_map_local_ollama():
    p = resolver.build_provider(
        {
            "provider": "local",
            "auth_type": "api_key",
            "base_url": "http://localhost:11434/v1",
            "model_id": "qwen2.5:7b",
        }
    )
    assert isinstance(p, OpenAICompatProvider)
    assert p.provider == "local"
    assert p.backend == "ollama"


def test_chat_raises_without_active(monkeypatch):
    monkeypatch.setattr(resolver, "_fetch_active", lambda uid: None)
    with pytest.raises(resolver.NoActiveCredential):
        resolver.chat("u")


def test_chat_reads_active(monkeypatch):
    monkeypatch.setattr(
        resolver,
        "_fetch_active",
        lambda uid: {
            "provider": "local",
            "auth_type": "api_key",
            "base_url": "http://localhost:11434/v1",
            "model_id": "gemma3:12b",
        },
    )
    assert resolver.chat("u").provider == "local"


def test_lifeboat_none(monkeypatch):
    monkeypatch.setattr(resolver, "_fetch_lifeboat", lambda uid: None)
    assert resolver.lifeboat("u") is None


def test_lifeboat_local(monkeypatch):
    monkeypatch.setattr(
        resolver,
        "_fetch_lifeboat",
        lambda uid: {
            "provider": "local",
            "auth_type": "api_key",
            "base_url": "http://localhost:11434/v1",
            "model_id": "gemma3:12b",
        },
    )
    lb = resolver.lifeboat("u")
    assert lb is not None and lb.provider == "local"
