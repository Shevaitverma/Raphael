from llm.anthropic_api import AnthropicAPIProvider
from llm.openai_compat import OpenAICompatProvider


def _local(model):
    return OpenAICompatProvider(
        base_url="http://localhost:11434/v1", api_key="ollama", model=model, backend="ollama"
    )


def test_gemma3_native_tools_false():
    assert _local("gemma3:12b").capabilities().native_tools is False


def test_llama2_native_tools_false():
    assert _local("llama2").capabilities().native_tools is False


def test_qwen_native_tools_true():
    assert _local("qwen2.5:7b").capabilities().native_tools is True


def test_anthropic_capabilities():
    c = AnthropicAPIProvider(api_key="sk-x", model="claude-opus-4-8").capabilities()
    assert c.native_tools is True
    assert c.streaming is True
    assert c.json_schema is True
    assert c.max_context_tokens >= 200_000
