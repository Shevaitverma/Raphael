import json
from types import SimpleNamespace

from llm.anthropic_api import neutral_from_anthropic


def _block(**k):
    return SimpleNamespace(**k)


def test_neutral_strips_thinking_and_provider_tool_ids():
    resp = SimpleNamespace(
        stop_reason="tool_use",
        content=[
            _block(type="thinking", thinking="secret chain of thought", signature="sig"),
            _block(type="tool_use", id="toolu_abc123", name="get_weather", input={"city": "Paris"}),
            _block(type="text", text="Hello there"),
        ],
    )
    msg = neutral_from_anthropic(resp, "claude-opus-4-8")

    assert msg.text == "Hello there"
    assert msg.tool_calls == [{"name": "get_weather", "arguments": {"city": "Paris"}}]

    # The row we would persist to conv-svc: neutral shape only.
    persisted = {"role": "assistant", "content": msg.text, "tool_calls": msg.tool_calls}
    blob = json.dumps(persisted)
    assert "toolu_" not in blob  # no provider tool-call id
    assert "thinking" not in blob  # no thinking block
    assert "secret chain of thought" not in blob
