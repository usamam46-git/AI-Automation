"""
core/llm_client.py — The single internal OpenAI wrapper (Vol. 2 §8.1).

Every LLM call in the platform goes through this module rather than scattered
`openai.chat.completions.create()` calls, so that retries/backoff, cost
calculation, token counting, and LangSmith tracing are applied uniformly — and
so that a future multi-provider need (Anthropic, open-weight models) means
changing one file.

Usage:
    from src.core.llm_client import get_llm_client

    client = get_llm_client()                 # platform key from settings
    result = client.parse(
        messages=[{"role": "system", "content": "..."},
                  {"role": "user", "content": "..."}],
        response_format=InvoiceExtraction,    # Pydantic model OR JSON Schema dict
    )
    result.parsed          # -> dict
    result.cost_usd        # -> float
    result.tokens_prompt   # -> int

Structured outputs (Vol. 4 §6):
  Callers never ask the model to "output JSON" in free text and then parse it.
  `response_format` is either a Pydantic model class (routed through the SDK's
  native `.parse()` helper) or a JSON Schema dict (routed through `.create()`
  with OpenAI strict `json_schema` mode). Both paths return `parsed` as a plain
  JSON-serializable dict so the value can be written straight into LangGraph
  state and addressed by the condition DSL.

Embeddings (Vol. 2 §3.4, Vol. 4 §7):
    client.embed(texts=["chunk one", "chunk two"], model=kb.embedding_model)

  Same chokepoint rationale as completions, plus one specific to embeddings: the
  `dimensions` parameter is resolved from `_EMBEDDING_MODELS` and can never be
  supplied by a caller. `text-embedding-3-large` is native-3072 but requested at
  1536 to match `document_chunks.embedding` (`Vector(1536)`), and a single call
  site that forgot to truncate would either hard-fail at INSERT or poison the
  shared HNSW index. `model` is required here — there is deliberately no
  settings-level default; see `embed()`.

Synchronous by design:
  This client uses the blocking `OpenAI` client, not `AsyncOpenAI`. Its only
  caller today is a LangGraph node handler, which must stay sync so that
  compiled graphs remain invocable via both `.invoke()` and `.astream()`.
  LangGraph runs sync nodes in a threadpool, and the Celery worker is
  process-concurrent, so blocking here is correct. If a FastAPI route ever
  needs this directly, add an `aparse()` sibling backed by `AsyncOpenAI`.

Not implemented yet (deliberate):
  - Vol. 6 §12 calls for a Prometheus token-spend metric emitted from this
    client for the org monthly-cap alert. Deferred until the billing module.
  - Model escalation on low confidence (Vol. 4 §11.1) belongs to the caller,
    not here — this client makes exactly one model call per `parse()`.
"""

from __future__ import annotations

import json
import logging
import re
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

from openai import (
    APIConnectionError,
    APITimeoutError,
    InternalServerError,
    OpenAI,
    RateLimitError,
)
from pydantic import BaseModel

from src.core.config import settings

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class LLMError(Exception):
    """Base class for all failures raised by LLMClient."""


class LLMConfigurationError(LLMError):
    """Static misconfiguration — missing API key, or an unusable output schema."""


class LLMTransientError(LLMError):
    """A retryable provider error that survived all retry attempts."""


# ---------------------------------------------------------------------------
# Pricing
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ModelPricing:
    """Per-1,000,000-token USD rates for a single model."""

    input: float
    cached_input: float
    output: float


# !!! MANUAL MAINTENANCE REQUIRED !!!
#
# OpenAI publishes no pricing API, so these rates cannot be fetched at runtime —
# they are transcribed by hand and WILL go stale. Re-verify them against
# https://platform.openai.com/docs/pricing whenever:
#   - OpenAI announces a pricing change, or
#   - a new model is added to this table.
#
# Rates below are the standard tier (not Batch, not Flex/Fast), USD per 1M
# tokens, verified 2026-08-03.
_MODEL_PRICING: dict[str, ModelPricing] = {
    "gpt-4.1": ModelPricing(input=2.00, cached_input=0.50, output=8.00),
    "gpt-4.1-mini": ModelPricing(input=0.40, cached_input=0.10, output=1.60),
    "gpt-4.1-nano": ModelPricing(input=0.10, cached_input=0.025, output=0.40),
}

# Unknown models bill at the most expensive known rate rather than silently
# computing $0.00 — an over-estimate is a visible anomaly, a zero is invisible.
_FALLBACK_PRICING_MODEL = "gpt-4.1"

# A dated deployment suffix, e.g. the "-2025-04-14" of "gpt-4.1-mini-2025-04-14".
# These are pinned snapshots of the base model and genuinely share its pricing.
_DATED_SUFFIX = re.compile(r"^-\d{4}-\d{2}-\d{2}$")


def _pricing_for(model: str) -> ModelPricing:
    """
    Resolve pricing for a model id, falling back loudly rather than to zero.

    Matching rules, in order:
      1. Exact table hit.
      2. Longest matching prefix at a NAME-SEGMENT boundary. Longest matters
         because "gpt-4.1" is a prefix of "gpt-4.1-mini-..." — naive iteration
         would bill mini calls at full gpt-4.1 rates (5x). The boundary check
         stops a hypothetical "gpt-4.1-minimal" from matching "gpt-4.1-mini".
      3. Nothing matched — warn and use the most expensive known rate.

    A prefix match only stays silent when the remainder is a dated suffix. Any
    other variant (audio, vision, preview tiers — which OpenAI has historically
    priced differently) is billed at base rates but warns, because otherwise a
    mispriced variant would be completely invisible.
    """
    pricing = _MODEL_PRICING.get(model)
    if pricing is not None:
        return pricing

    for known in sorted(_MODEL_PRICING, key=len, reverse=True):
        if not model.startswith(known + "-"):
            continue
        suffix = model[len(known) :]
        if not _DATED_SUFFIX.match(suffix):
            logger.warning(
                "Model '%s' is an unrecognized variant of '%s' — billing at base rates, which may be wrong. "
                "Add it to _MODEL_PRICING in src/core/llm_client.py if its rates differ.",
                model,
                known,
            )
        return _MODEL_PRICING[known]

    logger.warning(
        "No pricing entry for model '%s' — billing it at '%s' rates. Add it to _MODEL_PRICING in src/core/llm_client.py.",
        model,
        _FALLBACK_PRICING_MODEL,
    )
    return _MODEL_PRICING[_FALLBACK_PRICING_MODEL]


def calculate_cost_usd(*, model: str, tokens_prompt: int, tokens_completion: int, tokens_cached: int = 0) -> float:
    """
    Compute the USD cost of one completion from its token usage.

    `tokens_cached` is a SUBSET of `tokens_prompt` (that is how OpenAI reports
    it in `usage.prompt_tokens_details.cached_tokens`), billed at the discounted
    cached-input rate, so the uncached remainder is `tokens_prompt - tokens_cached`.
    """
    pricing = _pricing_for(model)
    uncached_prompt = max(0, tokens_prompt - tokens_cached)
    total = uncached_prompt * pricing.input + tokens_cached * pricing.cached_input + tokens_completion * pricing.output
    return total / 1_000_000


# ---------------------------------------------------------------------------
# Embedding models
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class EmbeddingModelSpec:
    """
    Everything the platform needs to know about one embedding model.

    `dimensions` is the size we ACTUALLY REQUEST, which is not necessarily the
    model's native output width — see `_EMBEDDING_MODELS` below. It is the single
    authority for the `dimensions` parameter sent to OpenAI; no call site may
    choose its own, because the value has to match the width of
    `document_chunks.embedding` exactly.
    """

    native_dimensions: int
    dimensions: int
    price_per_million: float


# The width of `document_chunks.embedding` (`Vector(1536)`) and of
# `agent_memory.embedding`. Changing it means an Alembic migration that alters
# the column type AND re-embeds every existing row — the stored vectors cannot
# be converted, only regenerated.
EMBEDDING_COLUMN_DIMENSIONS = 1536

# !!! MANUAL MAINTENANCE REQUIRED !!!
#
# Same standing caveat as _MODEL_PRICING above: no pricing API exists, so these
# rates are transcribed by hand and WILL go stale. USD per 1M tokens, standard
# tier. Re-verify against https://platform.openai.com/docs/pricing.
#
# On the text-embedding-3-large entry: its NATIVE output is 3072 dimensions, but
# we request 1536. That is not a downgrade to `-small` — the 3-series is
# Matryoshka-trained, so the leading 1536 dimensions of `-large` are themselves a
# well-formed embedding that still retrieves better than `-small` at the same
# width. It buys `-large`'s retrieval quality at `-small`'s storage cost, HNSW
# index size and query latency, with no migration. The ONLY cost is the API rate.
#
# Every `dimensions` value here MUST equal EMBEDDING_COLUMN_DIMENSIONS — the
# check below enforces it at import rather than letting a mismatch surface as a
# failed INSERT during ingestion.
_EMBEDDING_MODELS: dict[str, EmbeddingModelSpec] = {
    "text-embedding-3-large": EmbeddingModelSpec(native_dimensions=3072, dimensions=1536, price_per_million=0.13),
    "text-embedding-3-small": EmbeddingModelSpec(native_dimensions=1536, dimensions=1536, price_per_million=0.02),
}

_MISDIMENSIONED_MODELS = {name: spec.dimensions for name, spec in _EMBEDDING_MODELS.items() if spec.dimensions != EMBEDDING_COLUMN_DIMENSIONS}
if _MISDIMENSIONED_MODELS:
    raise LLMConfigurationError(
        f"_EMBEDDING_MODELS entries request dimensions that do not fit the vector columns "
        f"(Vector({EMBEDDING_COLUMN_DIMENSIONS})): {_MISDIMENSIONED_MODELS}. Either request "
        f"{EMBEDDING_COLUMN_DIMENSIONS} dimensions, or ship a migration that alters BOTH "
        f"document_chunks.embedding and agent_memory.embedding and re-embeds every existing row."
    )

# OpenAI's embeddings endpoint accepts at most this many inputs per request.
# Batching belongs to the ingestion pipeline, which knows document boundaries;
# this client only refuses an over-sized batch rather than silently splitting one
# (a split would make `tokens` and `cost_usd` cover several HTTP calls, breaking
# the one-result-per-call shape the rest of this module keeps).
_MAX_EMBEDDING_BATCH = 2048

#: Model ids accepted for `knowledge_bases.embedding_model`. A KB-creation
#: schema should validate against this rather than accepting free text — an
#: unknown value is unusable and only discovered at first ingestion.
SUPPORTED_EMBEDDING_MODELS: frozenset[str] = frozenset(_EMBEDDING_MODELS)


def embedding_spec_for(model: str) -> EmbeddingModelSpec:
    """
    Resolve an embedding model id to its spec, or raise.

    **This fails CLOSED, unlike `_pricing_for` above, and the asymmetry is
    deliberate.** A wrong price is a reporting error someone can reconcile later;
    a wrong dimension count is a corrupt index. Guessing 1536 for an unrecognized
    model would either hard-fail at INSERT or — far worse, if the guess happens
    to fit — silently write vectors from a different model into the same HNSW
    index as everything else, making every subsequent cosine search quietly wrong
    with no error anywhere. There is no safe default, so there is no default.

    A dated deployment suffix is accepted as the base model, matching
    `_pricing_for`'s rule.
    """
    spec = _EMBEDDING_MODELS.get(model)
    if spec is not None:
        return spec

    for known in sorted(_EMBEDDING_MODELS, key=len, reverse=True):
        if model.startswith(known + "-") and _DATED_SUFFIX.match(model[len(known) :]):
            return _EMBEDDING_MODELS[known]

    raise LLMConfigurationError(
        f"Unknown embedding model '{model}'. Known models: {sorted(_EMBEDDING_MODELS)}. "
        f"Add it to _EMBEDDING_MODELS in src/core/llm_client.py — including its dimension "
        f"count, which must match document_chunks.embedding."
    )


def embedding_dimensions_for(model: str) -> int:
    """Dimension count the platform requests for `model`. Raises on an unknown model."""
    return embedding_spec_for(model).dimensions


def calculate_embedding_cost_usd(*, model: str, tokens: int) -> float:
    """
    Compute the USD cost of one embedding call.

    Embeddings have no output tokens and no cached-input tier, so this is a flat
    per-token rate rather than the three-way split `calculate_cost_usd` performs.
    """
    return tokens * embedding_spec_for(model).price_per_million / 1_000_000


# ---------------------------------------------------------------------------
# Result envelope
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LLMResult:
    """Everything a caller needs from one structured completion."""

    parsed: dict[str, Any]
    model: str
    tokens_prompt: int
    tokens_completion: int
    tokens_cached: int
    cost_usd: float


@dataclass(frozen=True)
class EmbeddingResult:
    """
    Everything a caller needs from one embedding batch.

    `vectors` is positionally aligned with the `texts` argument that produced it —
    `vectors[i]` embeds `texts[i]`. That is guaranteed by `embed()` re-sorting on
    the API's `index` field, not assumed from response order.
    """

    vectors: list[list[float]]
    model: str
    dimensions: int
    tokens: int
    cost_usd: float


# ---------------------------------------------------------------------------
# JSON Schema normalization for OpenAI strict mode
# ---------------------------------------------------------------------------


def _normalize_strict_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """
    Return a copy of `schema` conforming to OpenAI's strict structured-output rules.

    Strict mode requires, on EVERY object in the schema: `additionalProperties:
    false`, and a `required` array naming every declared property. Both are
    injected here deterministically rather than rejected, because there is no
    ambiguity about intent — strict mode admits exactly one valid form — and it
    saves every schema author (including the Builder UI's node config panel)
    from having to encode the rule.

    Optional fields are still expressible the way OpenAI documents it: give the
    property a nullable type, e.g. {"type": ["string", "null"]}.
    """
    if not isinstance(schema, dict):
        raise LLMConfigurationError(f"output_schema must be a JSON Schema object, got {type(schema).__name__}")

    normalized: dict[str, Any] = dict(schema)

    if normalized.get("type") == "object" or "properties" in normalized:
        properties = normalized.get("properties")
        if not isinstance(properties, dict) or not properties:
            raise LLMConfigurationError("output_schema object must declare a non-empty 'properties' map")
        normalized["type"] = "object"
        normalized["additionalProperties"] = False
        normalized["required"] = list(properties.keys())
        normalized["properties"] = {key: _normalize_strict_schema(value) if isinstance(value, dict) else value for key, value in properties.items()}

    items = normalized.get("items")
    if isinstance(items, dict):
        normalized["items"] = _normalize_strict_schema(items)

    for combinator in ("anyOf", "oneOf", "allOf"):
        branches = normalized.get(combinator)
        if isinstance(branches, list):
            normalized[combinator] = [_normalize_strict_schema(b) if isinstance(b, dict) else b for b in branches]

    defs = normalized.get("$defs")
    if isinstance(defs, dict):
        normalized["$defs"] = {key: _normalize_strict_schema(value) if isinstance(value, dict) else value for key, value in defs.items()}

    return normalized


# ---------------------------------------------------------------------------
# LangSmith tracing hook
# ---------------------------------------------------------------------------


@contextmanager
def _traced(model: str) -> Iterator[None]:
    """
    Tracing integration point (Vol. 2 §8.3).

    Deliberately a no-op today: LANGSMITH_API_KEY defaults to empty and real
    LangSmith wiring is a later phase. When enabling, wrap the yield with
    langsmith's tracing context (or decorate `LLMClient._complete` with
    `@traceable`) — the call sites need no change.
    """
    if not settings.LANGSMITH_API_KEY:
        yield
        return

    logger.debug("LangSmith tracing hook reached for model=%s (project=%s) — wiring not yet implemented.", model, settings.LANGSMITH_PROJECT)
    yield


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

# Provider errors worth retrying: transient by nature (Vol. 2 §14). Everything
# else — AuthenticationError, BadRequestError, malformed schemas — is a bug or a
# config problem and must surface on the first attempt.
_RETRYABLE_ERRORS: tuple[type[Exception], ...] = (
    RateLimitError,
    APITimeoutError,
    APIConnectionError,
    InternalServerError,
)


class LLMClient:
    """
    Wrapper around OpenAI chat completions with structured outputs.

    Args:
        api_key_override: Use this key instead of settings.OPENAI_API_KEY. Wired
            from the `integrations` module (Vol. 2 §13): `graph_tasks._stream_graph`
            resolves a per-organization key, if stored, and binds it here via
            `functools.partial(get_llm_client, api_key_override=...)` before
            compiling — see `_resolve_llm_client_factory` in
            src/workers/graph_tasks.py. None when the org has no stored key.
        max_attempts: Total attempts including the first (Vol. 2 §14 specifies 3).
        retry_base_delay: Seconds for the first backoff; doubles each retry
            (1s, 2s, 4s), mirroring the Celery task backoff in
            src/workers/graph_tasks.py. Tests pass 0.0 to avoid sleeping.
        timeout: Per-request timeout in seconds handed to the OpenAI SDK.
    """

    def __init__(
        self,
        *,
        api_key_override: str | None = None,
        max_attempts: int = 3,
        retry_base_delay: float = 1.0,
        timeout: float = 60.0,
    ) -> None:
        api_key = api_key_override or settings.OPENAI_API_KEY
        if not api_key:
            raise LLMConfigurationError(
                "No OpenAI API key available: settings.OPENAI_API_KEY is empty and no api_key_override was supplied. "
                "Set OPENAI_API_KEY in apps/api/.env."
            )
        if max_attempts < 1:
            raise LLMConfigurationError(f"max_attempts must be >= 1, got {max_attempts}")

        self._max_attempts = max_attempts
        self._retry_base_delay = retry_base_delay
        # max_retries=0 — retries are owned by this class so that backoff,
        # logging, and the give-up error type stay under our control.
        self._client = OpenAI(api_key=api_key, timeout=timeout, max_retries=0)

    # -- public API ---------------------------------------------------------

    def parse(
        self,
        *,
        messages: list[dict[str, str]],
        response_format: type[BaseModel] | dict[str, Any],
        model: str | None = None,
        temperature: float = 0.0,
        max_tokens: int | None = None,
        schema_name: str = "structured_output",
    ) -> LLMResult:
        """
        Run one structured-output completion and return the parsed result plus usage.

        `response_format` may be a Pydantic model class (Vol. 4 §6's documented
        ergonomics) or a raw JSON Schema dict (what a workflow node config
        carries). Either way `LLMResult.parsed` is a plain dict.
        """
        resolved_model = model or settings.OPENAI_DEFAULT_MODEL

        if isinstance(response_format, type) and issubclass(response_format, BaseModel):
            completion = self._call_with_retry(
                self._client.chat.completions.parse,
                model=resolved_model,
                messages=messages,
                response_format=response_format,
                temperature=temperature,
                max_tokens=max_tokens,
            )
            message = completion.choices[0].message
            self._raise_on_refusal(message)
            parsed_model = message.parsed
            if parsed_model is None:
                raise LLMError("Model returned no parsed content despite a structured-output request.")
            parsed: dict[str, Any] = parsed_model.model_dump()
        else:
            strict_schema = _normalize_strict_schema(response_format)
            completion = self._call_with_retry(
                self._client.chat.completions.create,
                model=resolved_model,
                messages=messages,
                response_format={
                    "type": "json_schema",
                    "json_schema": {"name": schema_name, "strict": True, "schema": strict_schema},
                },
                temperature=temperature,
                max_tokens=max_tokens,
            )
            message = completion.choices[0].message
            self._raise_on_refusal(message)
            parsed = self._decode_json_content(message.content)

        return self._build_result(completion, resolved_model, parsed)

    def embed(self, *, texts: list[str], model: str) -> EmbeddingResult:
        """
        Embed a batch of texts, returning vectors positionally aligned with `texts`.

        `model` is REQUIRED — unlike `parse()`, there is no settings fallback, and
        that is deliberate. Every embedding must be produced by the same model as
        the corpus it will be compared against, and the authority for that is the
        owning `knowledge_bases.embedding_model` row. A module-level default would
        let a caller embed a QUERY with one model against a corpus built with
        another; cosine similarity across two embedding spaces returns plausible
        numbers and meaningless rankings, with nothing raising anywhere.

        The `dimensions` sent to OpenAI comes from `_EMBEDDING_MODELS`, never from
        the caller, so a truncated model (text-embedding-3-large at 1536) cannot
        be requested at the wrong width from one forgetful call site.
        """
        spec = embedding_spec_for(model)

        if not texts:
            # No API call — an empty request is a 400, and a no-op batch is a
            # legitimate state for a document that chunked to nothing.
            return EmbeddingResult(vectors=[], model=model, dimensions=spec.dimensions, tokens=0, cost_usd=0.0)

        if len(texts) > _MAX_EMBEDDING_BATCH:
            raise LLMConfigurationError(
                f"embed() received {len(texts)} texts; OpenAI accepts at most {_MAX_EMBEDDING_BATCH} inputs "
                f"per request. Batch upstream — the ingestion pipeline owns chunk batching, not this client."
            )

        for index, text in enumerate(texts):
            if not text or not text.strip():
                raise LLMConfigurationError(
                    f"embed() received an empty/whitespace-only text at index {index}. OpenAI rejects these, "
                    f"and an empty chunk has nothing to retrieve on — drop it during chunking instead."
                )

        response = self._call_with_retry(
            self._client.embeddings.create,
            model=model,
            input=texts,
            dimensions=spec.dimensions,
        )

        # Sort by the API's own `index` rather than trusting response order. The
        # endpoint documents that data MAY come back out of order, and a silent
        # misalignment here attaches every chunk's vector to a different chunk.
        items = sorted(response.data, key=lambda item: item.index)
        if len(items) != len(texts):
            raise LLMError(f"Embedding count mismatch: sent {len(texts)} texts, received {len(items)} vectors.")

        vectors = [list(item.embedding) for item in items]
        for position, vector in enumerate(vectors):
            if len(vector) != spec.dimensions:
                raise LLMError(
                    f"Embedding at index {position} has {len(vector)} dimensions, expected {spec.dimensions}. "
                    f"Refusing to return vectors that cannot be stored."
                )

        usage = getattr(response, "usage", None)
        tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
        billed_model = str(getattr(response, "model", "") or model)

        # Cost is computed from the REQUESTED model, not the echoed one — the
        # opposite of `_build_result` above, on purpose. `embedding_spec_for`
        # raises on an unknown id, so pricing an unrecognized echoed variant here
        # would discard a batch of vectors we already paid for and successfully
        # received. The requested id is known-good by construction.
        return EmbeddingResult(
            vectors=vectors,
            model=billed_model,
            dimensions=spec.dimensions,
            tokens=tokens,
            cost_usd=calculate_embedding_cost_usd(model=model, tokens=tokens),
        )

    # -- internals ----------------------------------------------------------

    def _call_with_retry(self, api_call: Any, *, max_tokens: int | None = None, **kwargs: Any) -> Any:
        """
        Invoke an OpenAI SDK method, retrying transient failures with exponential backoff.

        Mirrors the `2 ** attempt` backoff already used by the Celery tasks in
        src/workers/graph_tasks.py rather than introducing a second retry
        mechanism (tenacity is only a transitive langchain pin, not a declared
        dependency of this project).
        """
        # gpt-4.1-era models take max_completion_tokens; omit entirely when unset
        # so the provider default applies.
        if max_tokens is not None:
            kwargs["max_completion_tokens"] = max_tokens

        last_error: Exception | None = None
        for attempt in range(self._max_attempts):
            try:
                with _traced(str(kwargs.get("model"))):
                    return api_call(**kwargs)
            except _RETRYABLE_ERRORS as exc:
                last_error = exc
                if attempt == self._max_attempts - 1:
                    break
                delay = self._retry_base_delay * (2**attempt)
                logger.warning(
                    "Transient OpenAI error (%s) on attempt %d/%d — retrying in %.1fs: %s",
                    type(exc).__name__,
                    attempt + 1,
                    self._max_attempts,
                    delay,
                    exc,
                )
                if delay > 0:
                    time.sleep(delay)

        raise LLMTransientError(
            f"OpenAI call failed after {self._max_attempts} attempts. Last error: {type(last_error).__name__}: {last_error}"
        ) from last_error

    @staticmethod
    def _raise_on_refusal(message: Any) -> None:
        """Surface a model-side safety refusal as an error instead of an empty parse."""
        refusal = getattr(message, "refusal", None)
        if refusal:
            raise LLMError(f"Model refused the request: {refusal}")

    @staticmethod
    def _decode_json_content(content: str | None) -> dict[str, Any]:
        """Decode strict json_schema output; a failure here means the provider broke its own contract."""
        if not content:
            raise LLMError("Model returned empty content despite a structured-output request.")
        try:
            decoded = json.loads(content)
        except json.JSONDecodeError as exc:
            raise LLMError(f"Model returned non-JSON content under strict json_schema mode: {exc}") from exc
        if not isinstance(decoded, dict):
            raise LLMError(f"Structured output must decode to an object, got {type(decoded).__name__}.")
        return decoded

    @staticmethod
    def _build_result(completion: Any, requested_model: str, parsed: dict[str, Any]) -> LLMResult:
        """Extract usage from the completion and compute cost."""
        usage = getattr(completion, "usage", None)
        tokens_prompt = int(getattr(usage, "prompt_tokens", 0) or 0)
        tokens_completion = int(getattr(usage, "completion_tokens", 0) or 0)

        details = getattr(usage, "prompt_tokens_details", None)
        tokens_cached = int(getattr(details, "cached_tokens", 0) or 0)

        # Prefer the model id the API echoes back — it is the dated deployment
        # actually billed, which may differ from the alias we requested.
        billed_model = str(getattr(completion, "model", "") or requested_model)

        return LLMResult(
            parsed=parsed,
            model=billed_model,
            tokens_prompt=tokens_prompt,
            tokens_completion=tokens_completion,
            tokens_cached=tokens_cached,
            cost_usd=calculate_cost_usd(
                model=billed_model,
                tokens_prompt=tokens_prompt,
                tokens_completion=tokens_completion,
                tokens_cached=tokens_cached,
            ),
        )


def get_llm_client(api_key_override: str | None = None, **kwargs: Any) -> LLMClient:
    """
    Factory for an LLMClient.

    Deliberately constructs a fresh client per call rather than memoizing one:
    a cached instance would capture the platform key, defeating the per-org key
    override that BYOK needs, and would hold a pre-patch SDK object in tests.
    """
    return LLMClient(api_key_override=api_key_override, **kwargs)
