"""
tests/test_llm_client.py — Unit tests for the OpenAI wrapper (src/core/llm_client.py).

The OpenAI SDK is mocked at its boundary in every test — `src.core.llm_client.OpenAI`
is patched so no test in this file opens a network connection or spends API credit.
"""

import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import httpx
import pytest
from openai import APITimeoutError, AuthenticationError, RateLimitError
from pydantic import BaseModel

from src.core import llm_client as llm_client_module
from src.core.llm_client import (
    LLMClient,
    LLMConfigurationError,
    LLMTransientError,
    _normalize_strict_schema,
    calculate_cost_usd,
    get_llm_client,
)

# ---------------------------------------------------------------------------
# Helpers — fake SDK response objects
# ---------------------------------------------------------------------------

_SCHEMA = {
    "type": "object",
    "properties": {
        "vendor_name": {"type": "string"},
        "amount": {"type": "number"},
        "confidence": {"type": "number"},
    },
}


def _usage(prompt: int = 1000, completion: int = 500, cached: int = 0) -> SimpleNamespace:
    return SimpleNamespace(
        prompt_tokens=prompt,
        completion_tokens=completion,
        prompt_tokens_details=SimpleNamespace(cached_tokens=cached),
    )


def _json_completion(payload: dict, *, model: str = "gpt-4.1-mini", usage: SimpleNamespace | None = None) -> SimpleNamespace:
    """A chat.completions.create() response carrying strict json_schema content."""
    message = SimpleNamespace(content=json.dumps(payload), refusal=None, parsed=None)
    return SimpleNamespace(choices=[SimpleNamespace(message=message)], model=model, usage=usage or _usage())


def _parsed_completion(model_instance: BaseModel, *, model: str = "gpt-4.1-mini", usage: SimpleNamespace | None = None) -> SimpleNamespace:
    """A chat.completions.parse() response carrying a Pydantic instance."""
    message = SimpleNamespace(content=None, refusal=None, parsed=model_instance)
    return SimpleNamespace(choices=[SimpleNamespace(message=message)], model=model, usage=usage or _usage())


def _rate_limit_error() -> RateLimitError:
    request = httpx.Request("POST", "https://api.openai.com/v1/chat/completions")
    return RateLimitError("rate limited", response=httpx.Response(429, request=request), body=None)


def _auth_error() -> AuthenticationError:
    request = httpx.Request("POST", "https://api.openai.com/v1/chat/completions")
    return AuthenticationError("bad key", response=httpx.Response(401, request=request), body=None)


def _client_with(mock_openai: MagicMock, **kwargs) -> LLMClient:
    """Build an LLMClient bound to a patched SDK, with retries that never sleep."""
    kwargs.setdefault("api_key_override", "sk-test")
    kwargs.setdefault("retry_base_delay", 0.0)
    client = LLMClient(**kwargs)
    assert mock_openai.called
    return client


# ---------------------------------------------------------------------------
# Structured output parsing
# ---------------------------------------------------------------------------


def test_parse_with_json_schema_returns_structured_dict():
    payload = {"vendor_name": "Acme Corp", "amount": 1250.50, "confidence": 0.93}

    with patch("src.core.llm_client.OpenAI") as mock_openai:
        mock_openai.return_value.chat.completions.create.return_value = _json_completion(payload)
        client = _client_with(mock_openai)

        result = client.parse(messages=[{"role": "user", "content": "extract"}], response_format=_SCHEMA)

    assert result.parsed == payload
    assert result.parsed["confidence"] == 0.93
    assert result.model == "gpt-4.1-mini"
    assert result.tokens_prompt == 1000
    assert result.tokens_completion == 500
    assert result.cost_usd > 0


def test_parse_with_json_schema_sends_strict_response_format():
    with patch("src.core.llm_client.OpenAI") as mock_openai:
        create = mock_openai.return_value.chat.completions.create
        create.return_value = _json_completion({"vendor_name": "A", "amount": 1.0, "confidence": 0.5})
        client = _client_with(mock_openai)

        client.parse(messages=[{"role": "user", "content": "x"}], response_format=_SCHEMA, model="gpt-4.1", max_tokens=256)

    kwargs = create.call_args.kwargs
    assert kwargs["model"] == "gpt-4.1"
    assert kwargs["max_completion_tokens"] == 256
    response_format = kwargs["response_format"]
    assert response_format["type"] == "json_schema"
    assert response_format["json_schema"]["strict"] is True
    assert response_format["json_schema"]["schema"]["additionalProperties"] is False


def test_parse_with_pydantic_model_uses_sdk_parse_helper():
    class InvoiceExtraction(BaseModel):
        vendor_name: str
        amount: float
        confidence: float

    instance = InvoiceExtraction(vendor_name="Globex", amount=42.0, confidence=0.81)

    with patch("src.core.llm_client.OpenAI") as mock_openai:
        parse_method = mock_openai.return_value.chat.completions.parse
        parse_method.return_value = _parsed_completion(instance)
        client = _client_with(mock_openai)

        result = client.parse(messages=[{"role": "user", "content": "extract"}], response_format=InvoiceExtraction)

    assert parse_method.called
    assert mock_openai.return_value.chat.completions.create.called is False
    # Always a plain dict, regardless of which path produced it.
    assert result.parsed == {"vendor_name": "Globex", "amount": 42.0, "confidence": 0.81}


def test_parse_reports_model_actually_billed_not_alias_requested():
    with patch("src.core.llm_client.OpenAI") as mock_openai:
        mock_openai.return_value.chat.completions.create.return_value = _json_completion(
            {"vendor_name": "A", "amount": 1.0, "confidence": 0.5},
            model="gpt-4.1-mini-2025-04-14",
        )
        client = _client_with(mock_openai)

        result = client.parse(messages=[{"role": "user", "content": "x"}], response_format=_SCHEMA, model="gpt-4.1-mini")

    assert result.model == "gpt-4.1-mini-2025-04-14"
    # Dated deployment ids must still resolve to their base model's pricing.
    assert result.cost_usd == pytest.approx(0.0012)


# ---------------------------------------------------------------------------
# Retry / backoff
# ---------------------------------------------------------------------------


def test_retry_succeeds_after_transient_rate_limit():
    payload = {"vendor_name": "Acme", "amount": 1.0, "confidence": 0.5}

    with patch("src.core.llm_client.OpenAI") as mock_openai:
        create = mock_openai.return_value.chat.completions.create
        create.side_effect = [_rate_limit_error(), _json_completion(payload)]
        client = _client_with(mock_openai)

        result = client.parse(messages=[{"role": "user", "content": "x"}], response_format=_SCHEMA)

    assert create.call_count == 2
    assert result.parsed == payload


def test_retry_gives_up_after_max_attempts():
    with patch("src.core.llm_client.OpenAI") as mock_openai:
        create = mock_openai.return_value.chat.completions.create
        create.side_effect = _rate_limit_error()
        client = _client_with(mock_openai, max_attempts=3)

        with pytest.raises(LLMTransientError, match="after 3 attempts"):
            client.parse(messages=[{"role": "user", "content": "x"}], response_format=_SCHEMA)

    assert create.call_count == 3


def test_retry_covers_timeout_errors():
    payload = {"vendor_name": "Acme", "amount": 1.0, "confidence": 0.5}
    request = httpx.Request("POST", "https://api.openai.com/v1/chat/completions")

    with patch("src.core.llm_client.OpenAI") as mock_openai:
        create = mock_openai.return_value.chat.completions.create
        create.side_effect = [APITimeoutError(request=request), _json_completion(payload)]
        client = _client_with(mock_openai)

        result = client.parse(messages=[{"role": "user", "content": "x"}], response_format=_SCHEMA)

    assert create.call_count == 2
    assert result.parsed == payload


def test_auth_error_is_not_retried():
    """A bad key is a config problem — it must surface on the first attempt."""
    with patch("src.core.llm_client.OpenAI") as mock_openai:
        create = mock_openai.return_value.chat.completions.create
        create.side_effect = _auth_error()
        client = _client_with(mock_openai)

        with pytest.raises(AuthenticationError):
            client.parse(messages=[{"role": "user", "content": "x"}], response_format=_SCHEMA)

    assert create.call_count == 1


def test_backoff_delays_double_between_attempts():
    with patch("src.core.llm_client.OpenAI") as mock_openai, patch("src.core.llm_client.time.sleep") as mock_sleep:
        mock_openai.return_value.chat.completions.create.side_effect = _rate_limit_error()
        client = _client_with(mock_openai, retry_base_delay=1.0, max_attempts=3)

        with pytest.raises(LLMTransientError):
            client.parse(messages=[{"role": "user", "content": "x"}], response_format=_SCHEMA)

    # 1s then 2s — no sleep after the final failed attempt.
    assert [call.args[0] for call in mock_sleep.call_args_list] == [1.0, 2.0]


# ---------------------------------------------------------------------------
# Cost calculation
# ---------------------------------------------------------------------------


def test_cost_calculation_for_known_token_counts():
    # gpt-4.1-mini: $0.40 / 1M input, $1.60 / 1M output
    # 1000 * 0.40/1e6 + 500 * 1.60/1e6 = 0.0004 + 0.0008
    cost = calculate_cost_usd(model="gpt-4.1-mini", tokens_prompt=1000, tokens_completion=500)
    assert cost == pytest.approx(0.0012)


def test_cost_calculation_discounts_cached_prompt_tokens():
    # cached_tokens is a SUBSET of prompt_tokens: 600 uncached + 400 cached.
    # 600 * 0.40/1e6 + 400 * 0.10/1e6 + 500 * 1.60/1e6
    cost = calculate_cost_usd(model="gpt-4.1-mini", tokens_prompt=1000, tokens_completion=500, tokens_cached=400)
    assert cost == pytest.approx(0.00108)


def test_cost_calculation_for_full_size_model():
    # gpt-4.1: $2.00 / 1M input, $8.00 / 1M output
    cost = calculate_cost_usd(model="gpt-4.1", tokens_prompt=1000, tokens_completion=500)
    assert cost == pytest.approx(0.006)


@pytest.mark.parametrize(
    ("model", "expected_cost"),
    [
        # Dated deployment ids resolve to their base model, at every table depth.
        ("gpt-4.1-mini-2025-04-14", 0.0012),
        ("gpt-4.1-nano-2025-08-01", 0.0003),
        ("gpt-4.1-2025-04-14", 0.006),
        # The regression case: "gpt-4.1" is a prefix of "gpt-4.1-mini-...", so the
        # longest prefix must win or mini calls get billed at 5x.
        ("gpt-4.1-mini-vision-2025-06-01", 0.0012),
    ],
)
def test_longest_prefix_wins_for_dated_and_variant_ids(model, expected_cost):
    assert calculate_cost_usd(model=model, tokens_prompt=1000, tokens_completion=500) == pytest.approx(expected_cost)


def test_dated_deployment_suffix_does_not_warn(caplog):
    """A pinned snapshot genuinely shares its base model's pricing — no noise."""
    with caplog.at_level("WARNING"):
        calculate_cost_usd(model="gpt-4.1-mini-2025-04-14", tokens_prompt=10, tokens_completion=10)

    assert caplog.text == ""


def test_unrecognized_variant_bills_at_base_rate_but_warns(caplog):
    """
    OpenAI has priced audio/vision variants differently from their text base.
    Prefix matching must not silently swallow that — a wrong cost with no log
    line is invisible until billing reconciliation.
    """
    with caplog.at_level("WARNING"):
        cost = calculate_cost_usd(model="gpt-4.1-mini-audio-preview", tokens_prompt=1000, tokens_completion=500)

    assert cost == pytest.approx(0.0012)  # base mini rates
    assert "unrecognized variant" in caplog.text
    assert "gpt-4.1-mini-audio-preview" in caplog.text


def test_prefix_match_requires_a_name_segment_boundary(caplog):
    """
    'gpt-4.1-minimal' must not match 'gpt-4.1-mini' — it is a different name,
    not a variant of it. It falls back to the next valid segment prefix,
    'gpt-4.1', and warns rather than silently taking mini's cheaper rates.
    """
    with caplog.at_level("WARNING"):
        cost = calculate_cost_usd(model="gpt-4.1-minimal", tokens_prompt=1000, tokens_completion=500)

    assert cost == pytest.approx(0.006)  # gpt-4.1 rates
    assert cost != pytest.approx(0.0012)  # NOT gpt-4.1-mini rates
    assert "unrecognized variant of 'gpt-4.1'" in caplog.text


def test_unknown_model_falls_back_loudly_not_to_zero(caplog):
    with caplog.at_level("WARNING"):
        cost = calculate_cost_usd(model="some-future-model", tokens_prompt=1000, tokens_completion=500)

    assert cost > 0
    assert cost == pytest.approx(0.006)  # billed at the gpt-4.1 fallback rate
    assert "No pricing entry" in caplog.text


def test_result_cost_flows_from_response_usage():
    with patch("src.core.llm_client.OpenAI") as mock_openai:
        mock_openai.return_value.chat.completions.create.return_value = _json_completion(
            {"vendor_name": "A", "amount": 1.0, "confidence": 0.5},
            usage=_usage(prompt=2000, completion=1000, cached=500),
        )
        client = _client_with(mock_openai)

        result = client.parse(messages=[{"role": "user", "content": "x"}], response_format=_SCHEMA)

    assert result.tokens_prompt == 2000
    assert result.tokens_completion == 1000
    assert result.tokens_cached == 500
    # 1500 * 0.40/1e6 + 500 * 0.10/1e6 + 1000 * 1.60/1e6
    assert result.cost_usd == pytest.approx(0.00225)


# ---------------------------------------------------------------------------
# Configuration errors
# ---------------------------------------------------------------------------


def test_missing_api_key_fails_clearly(monkeypatch):
    monkeypatch.setattr(llm_client_module.settings, "OPENAI_API_KEY", "")

    with pytest.raises(LLMConfigurationError, match="OPENAI_API_KEY"):
        LLMClient()


def test_api_key_override_is_used_when_settings_key_is_empty(monkeypatch):
    monkeypatch.setattr(llm_client_module.settings, "OPENAI_API_KEY", "")

    with patch("src.core.llm_client.OpenAI") as mock_openai:
        # This is the BYOK seam — Day 3 passes a per-org key here unchanged.
        get_llm_client("sk-org-specific-key")

    assert mock_openai.call_args.kwargs["api_key"] == "sk-org-specific-key"


def test_override_takes_precedence_over_settings_key(monkeypatch):
    monkeypatch.setattr(llm_client_module.settings, "OPENAI_API_KEY", "sk-platform")

    with patch("src.core.llm_client.OpenAI") as mock_openai:
        get_llm_client("sk-org")

    assert mock_openai.call_args.kwargs["api_key"] == "sk-org"


def test_settings_key_used_when_no_override(monkeypatch):
    monkeypatch.setattr(llm_client_module.settings, "OPENAI_API_KEY", "sk-platform")

    with patch("src.core.llm_client.OpenAI") as mock_openai:
        get_llm_client()

    assert mock_openai.call_args.kwargs["api_key"] == "sk-platform"


# ---------------------------------------------------------------------------
# Strict schema normalization
# ---------------------------------------------------------------------------


def test_normalize_injects_strict_mode_requirements():
    normalized = _normalize_strict_schema(_SCHEMA)

    assert normalized["additionalProperties"] is False
    assert set(normalized["required"]) == {"vendor_name", "amount", "confidence"}
    # The caller's schema must not be mutated in place.
    assert "additionalProperties" not in _SCHEMA


def test_normalize_recurses_into_nested_objects_and_arrays():
    schema = {
        "type": "object",
        "properties": {
            "vendor": {"type": "object", "properties": {"name": {"type": "string"}}},
            "line_items": {
                "type": "array",
                "items": {"type": "object", "properties": {"sku": {"type": "string"}, "qty": {"type": "integer"}}},
            },
        },
    }

    normalized = _normalize_strict_schema(schema)

    assert normalized["properties"]["vendor"]["additionalProperties"] is False
    assert normalized["properties"]["vendor"]["required"] == ["name"]
    items = normalized["properties"]["line_items"]["items"]
    assert items["additionalProperties"] is False
    assert set(items["required"]) == {"sku", "qty"}


def test_normalize_rejects_object_without_properties():
    with pytest.raises(LLMConfigurationError, match="properties"):
        _normalize_strict_schema({"type": "object"})


def test_normalize_rejects_non_dict_schema():
    with pytest.raises(LLMConfigurationError, match="JSON Schema object"):
        _normalize_strict_schema("not a schema")  # type: ignore[arg-type]
