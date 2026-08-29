"""
Per-node-type callables bound into LangGraph StateGraph nodes.

`condition`-type rows are NOT handled here — they compile into routing functions
on conditional edges, not executable graph nodes.

All handlers are synchronous by design. LangGraph runs sync nodes in a threadpool
under `astream()`, but an `async def` node cannot be driven by `.invoke()` — which
`compile_for_test_run` / `run_graph_sync` rely on. Keeping these sync means the
same compiled graph works under both entry points.
"""

from __future__ import annotations

import json
import logging
import re
import time
import uuid
from collections.abc import Callable
from typing import Any
from urllib.parse import quote

import httpx
from langgraph.types import interrupt

from src.core.llm_client import LLMClient, get_llm_client
from src.graphs.condition_eval import resolve_field_path

logger = logging.getLogger(__name__)


class NodeNotImplementedError(Exception):
    """Raised when a stub node handler is invoked before its module exists."""


class AgentNodeConfigError(Exception):
    """An agent node's config is missing or malformed — a structural error, never retried."""


class ToolNodeConfigError(Exception):
    """A tool node's config is missing or malformed — a structural error, never retried."""


class ToolExecutionError(Exception):
    """A tool's outbound call failed and survived all retry attempts (mirrors LLMTransientError)."""


class ToolAuthenticationError(Exception):
    """A tool's outbound call was rejected with 401/403 — a credential problem, never retried."""


#: Attribute the compiler's instrumentation wrapper stamps onto an exception so
#: the engine can tell which node raised it.
#:
#: **Tagging, not wrapping.** `stream_mode="updates"` yields a chunk only when a
#: node SUCCEEDS, so a raising node simply stops the stream and the engine used
#: to record the failure on the run row with no idea which node caused it — which
#: is why `node_executions` never contained a single `failed` row.
#:
#: The obvious fix is a wrapper exception, and it is wrong here: `graph_tasks`
#: classifies retryability by exception TYPE (`_NON_RETRYABLE` holds
#: `ToolExecutionError`, `AgentNodeConfigError`, …), so wrapping would make every
#: config error look retryable and re-drive a mutating tool three more times.
#: Stamping an attribute keeps the type, the message and the traceback intact, so
#: every existing `except` clause behaves exactly as before.
NODE_KEY_ATTR = "aap_node_key"


def node_key_of(exc: BaseException) -> str | None:
    """The node an exception was raised from, if the wrapper tagged it."""
    value = getattr(exc, NODE_KEY_ATTR, None)
    return value if isinstance(value, str) else None


def start_handler(_state: dict[str, Any]) -> dict[str, Any]:
    return {}


def end_handler(_state: dict[str, Any]) -> dict[str, Any]:
    return {}


def human_approval_handler(state: dict[str, Any], *, node_key: str) -> dict[str, Any]:
    """
    Calls LangGraph interrupt() to pause execution.

    node_key must be passed by the compiler closure so that graphs with multiple
    human_approval nodes key their decisions independently in node_outputs.
    Resume via Command(resume=...) is handled by the execution engine.
    """
    # `node_key` rides along so the engine can record WHICH gate a run is held
    # at. Before this, `_stream_graph` wrote the literal string "human_approval"
    # into `current_node_key`, which no graph with two gates could disambiguate
    # and which the frontend had to work around by guessing.
    payload = {
        "type": "approval_request",
        "node_key": node_key,
        "node_outputs": state.get("node_outputs", {}),
    }
    decision = interrupt(payload)
    node_outputs = dict(state.get("node_outputs", {}))
    node_outputs[node_key] = decision
    return {"node_outputs": node_outputs}


def _build_agent_input(state: dict[str, Any], input_fields: list[str]) -> dict[str, Any]:
    """
    Select only the state fields this node declared it needs (Vol. 4 §11.2).

    Dotted paths are resolved with the same `resolve_field_path` the conditional-edge
    DSL uses, so `input_fields` and edge `condition.field` address state identically.
    Passing compact structured data beats a prose dump: smaller prompts, cheaper, and
    less model distraction from irrelevant fields.
    """
    return {path: resolve_field_path(state, path) for path in input_fields}


def _agent_config(config: dict[str, Any] | None, node_key: str) -> dict[str, Any]:
    """
    Validate an agent node's inline config.

    TEMPORARY DENORMALIZATION: the config carries `model` / `system_prompt` /
    `output_schema` directly on the node instead of resolving `agent_id` against
    `agents` / `agent_versions` (Vol. 2 §3.3). Those tables exist but the agents
    module is models-only, so there is nothing to look up yet. When that module
    lands it should resolve `agent_id` into this same shape, keeping this handler
    and the Builder UI's node config panel unchanged.
    """
    config = config or {}

    system_prompt = config.get("system_prompt")
    if not system_prompt or not isinstance(system_prompt, str):
        raise AgentNodeConfigError(
            f"Agent node '{node_key}' has no usable 'system_prompt' in its config. "
            f"Inline agent config requires 'system_prompt' and 'output_schema'"
            + (" (an opaque 'agent_id' alone is not enough — the agents module is not implemented yet)." if config.get("agent_id") else ".")
        )

    output_schema = config.get("output_schema")
    if not output_schema or not isinstance(output_schema, dict):
        raise AgentNodeConfigError(
            f"Agent node '{node_key}' has no usable 'output_schema' in its config. "
            f"Structured output is mandatory (Vol. 4 §6) — free-text responses are never parsed"
            + (" (an opaque 'agent_id' alone is not enough — the agents module is not implemented yet)." if config.get("agent_id") else ".")
        )

    input_fields = config.get("input_fields") or ["trigger_payload"]
    if not isinstance(input_fields, list) or not all(isinstance(f, str) for f in input_fields):
        raise AgentNodeConfigError(f"Agent node '{node_key}' has a malformed 'input_fields' — expected a list of dotted state paths.")

    return {
        "model": config.get("model"),  # None → LLMClient falls back to settings.OPENAI_DEFAULT_MODEL
        "system_prompt": system_prompt,
        "output_schema": output_schema,
        "input_fields": input_fields,
        "temperature": float(config.get("temperature", 0.0)),
        "max_tokens": config.get("max_tokens"),
    }


def agent_handler(
    state: dict[str, Any],
    *,
    node_key: str,
    config: dict[str, Any] | None = None,
    client_factory: Callable[..., LLMClient] = get_llm_client,
) -> dict[str, Any]:
    """
    Run one structured LLM call for an `agent`-type node.

    The parsed result is written directly to `node_outputs[node_key]` (not nested
    under a wrapper key) so conditional edges can route on it with paths like
    `node_outputs.extract.confidence`.

    Token/cost usage rides back on a dedicated `node_usage` state channel rather
    than inside `node_outputs`: the execution engine streams with
    `stream_mode="updates"` and therefore only ever sees the dict this function
    returns, but polluting `node_outputs` would leak bookkeeping into the
    condition-DSL-addressable surface.

    `client_factory` is injectable so tests can supply a fake without patching
    module globals, and so `_compile_state_graph`/`_bind_node_handler` can bind
    a per-organization key here (Vol. 2 §13 BYOK) without changing this signature.

    Note: a single fixed model call. Escalating to a stronger model on low
    confidence (Vol. 4 §11.1) is deliberately not implemented here.
    """
    cfg = _agent_config(config, node_key)

    agent_input = _build_agent_input(state, cfg["input_fields"])
    messages = [
        {"role": "system", "content": cfg["system_prompt"]},
        {"role": "user", "content": json.dumps(agent_input, default=str)},
    ]

    client = client_factory()
    result = client.parse(
        messages=messages,
        response_format=cfg["output_schema"],
        model=cfg["model"],
        temperature=cfg["temperature"],
        max_tokens=cfg["max_tokens"],
        schema_name=f"{node_key}_output",
    )

    logger.info(
        "Agent node '%s' completed: model=%s tokens=%d/%d cost=$%.6f",
        node_key,
        result.model,
        result.tokens_prompt,
        result.tokens_completion,
        result.cost_usd,
    )

    # Copy-then-merge: node_outputs/node_usage have no reducer, so LangGraph
    # replaces the whole dict on write (same pattern as human_approval_handler).
    return {
        "node_outputs": {**state.get("node_outputs", {}), node_key: result.parsed},
        # What this node actually READ, keyed by the path it read it from. A null
        # here is a mis-typed `input_fields` path made visible — the single
        # failure mode nothing in the product used to report.
        "node_inputs": {**state.get("node_inputs", {}), node_key: agent_input},
        "node_usage": {
            **state.get("node_usage", {}),
            node_key: {
                "tokens_prompt": result.tokens_prompt,
                "tokens_completion": result.tokens_completion,
                "cost_usd": result.cost_usd,
                "model": result.model,
            },
        },
        "current_cost_usd": state.get("current_cost_usd", 0.0) + result.cost_usd,
    }


# ---------------------------------------------------------------------------
# Tool nodes (Vol. 2 §7.2)
# ---------------------------------------------------------------------------

_HTTP_METHODS = frozenset({"GET", "POST", "PUT", "PATCH", "DELETE"})

# Vol. 2 §7.2 defines four tool types. `python_function` (sandboxed pre-registered
# callables) and `mcp` are not built yet and are rejected by name rather than
# silently falling through to a generic branch.
#
# `knowledge_search` (days 6-7) is a FIFTH type the blueprint does not list. It
# ships as a tool rather than as a new `NodeType` on purpose: a node type would
# touch the backend enum, this dispatcher, the frontend node catalog, a config
# form AND `lib/graph-validation.ts`, which reimplements the backend rules in a
# second language. A tool type touches this function, and inherits the registry
# picker and `tool_executions` auditing already built.
_TOOL_TYPES = frozenset({"http_request", "erp_connector", "knowledge_search", "notify"})

# Channels with a transport behind them. `notifications.channel` documents a
# wider vocabulary (email | whatsapp | slack) that nothing delivers; those are
# rejected by name here rather than accepted and silently dropped, the same rule
# `python_function`/`mcp` follow. `webhook` covers Slack, Teams and Zapier
# incoming webhooks — they are all a POST with a JSON body — so naming a channel
# per vendor would be four spellings of one transport.
_NOTIFY_CHANNELS = frozenset({"in_app", "webhook"})

# Mock ERP actions and the payload fields each one requires. `erp_connector` makes
# no network call — it exists so the mutating-tool mechanism (and Vol. 5's ERP
# workflow shapes) can be proven end to end before a real ERPConnector adapter
# exists. When the tools module lands, these move to `tools.config`.
#
# The blueprint is not self-consistent about the journal-entry verb: Vol. 2 §7.2's
# ERPConnector interface and Vol. 5 §1 both say `create_journal_entry`, while
# Vol. 5 §5's diagram says `post_journal_entry`. Both are accepted so either
# workflow is buildable verbatim; `create_journal_entry` is canonical because it is
# the named interface method, not a diagram label. The configured spelling is echoed
# back unchanged so the audit trail records what the author actually asked for.
_ERP_REQUIRED_PAYLOAD: dict[str, tuple[str, ...]] = {
    "create_journal_entry": ("vendor", "amount", "account_code"),
    "post_journal_entry": ("vendor", "amount", "account_code"),
}

# Transport failures worth retrying, mirroring `_RETRYABLE_ERRORS` in llm_client.py.
# Everything else (invalid URL, TLS failure) is a config bug and must surface on
# the first attempt. httpx raises one HTTPStatusError for every 4xx/5xx rather than
# per-status classes, so status-based retry is decided on `status_code` below.
_RETRYABLE_HTTP_ERRORS: tuple[type[Exception], ...] = (
    httpx.TimeoutException,
    httpx.ConnectError,
    httpx.ReadError,
)

_RETRYABLE_STATUS = frozenset({429})

# Placeholder grammar for URL templating: `{vendor_id}` in a tool's `url`, filled
# from graph state via `url_fields`. Restricted to identifier characters so a
# malformed placeholder fails the config check instead of being left in the URL
# and silently requesting a literal `{vendor-id}` path segment.
_URL_PLACEHOLDER_RE = re.compile(r"\{([a-zA-Z_][a-zA-Z0-9_]*)\}")

# Failures that PROVE the request never reached the server, so replaying it cannot
# duplicate a write. `ConnectTimeout` is listed explicitly because httpx puts it
# under TimeoutException, not under ConnectError — its sibling `ReadTimeout` is
# the dangerous one (the server may have committed and simply not answered in
# time) and must never appear here.
_UNDELIVERED_ERRORS: tuple[type[Exception], ...] = (
    httpx.ConnectError,
    httpx.ConnectTimeout,
)

# Statuses where the server explicitly reports it did NOT process the request.
# 5xx is deliberately absent: a 500 can be raised after a commit.
_UNPROCESSED_STATUS = frozenset({429})

# Stable namespace for deterministic idempotency keys. Fixed forever — changing it
# changes every key this platform has ever sent, which is the one thing an
# idempotency key must not do.
_IDEMPOTENCY_NAMESPACE = uuid.UUID("6f6e1f9c-2c3a-5c7e-9f4b-9a7d1e2b3c4d")

DEFAULT_IDEMPOTENCY_HEADER = "Idempotency-Key"

# Credential rejections. Split out of the "4xx is data" bucket deliberately: a bad
# API key returned as node output is indistinguishable from a legitimate business
# 404, so a misconfigured tool would silently route down a "not found" branch
# instead of failing loudly. Mirrors LLMClient letting OpenAI's AuthenticationError
# surface on the first attempt rather than retrying it.
_AUTH_STATUS = frozenset({401, 403})


def get_http_client(**kwargs: Any) -> httpx.Client:
    """
    Factory for the outbound HTTP client used by `http_request` tool nodes.

    Indirection matters: resolving `httpx.Client` at call time (rather than binding
    it as a default argument) is what lets tests patch the SDK boundary, exactly as
    `get_llm_client` lets them patch `src.core.llm_client.OpenAI`.

    Sync, not async, on purpose — see the module docstring: an `async def` node
    cannot be driven by `.invoke()`, which `compile_for_test_run` relies on.

    **Redirects are followed, and that is a fix rather than a preference** (added
    2026-08-21). httpx defaults `follow_redirects=False`, unlike requests — and a
    3xx is below 500 and not in `_RETRYABLE_STATUS`, so `_run_http_request`
    classified it as "a definitive answer from the server" and handed the
    redirect's HTML body to the graph as the tool's result. Found live: a demo
    node calling `https://api.frankfurter.app/latest?from=EUR&to=USD` stored
    `{"status_code": 301, "body": "<html>...301 Moved Permanently...cloudflare"}`
    and the downstream agent reasoned over that instead of an FX rate, with
    nothing anywhere reporting a failure. Trailing-slash and http→https upgrades
    are the same trap and are far more common than that specific host.

    Two bounds come with it. `max_redirects` is deliberately low — a redirect
    chain is a remote party spending this worker's timeout budget. And httpx
    strips `Authorization` when a redirect leaves the origin (except a direct
    http→https upgrade on the same host), which covers the standard credential
    header; a **custom** auth header such as `X-API-Key` is NOT stripped by httpx
    and would travel to the redirect target, so a tool holding one should point at
    a URL that does not redirect. Callers may override either default.
    """
    kwargs.setdefault("follow_redirects", True)
    kwargs.setdefault("max_redirects", 5)
    return httpx.Client(**kwargs)


def _resolve_field_map(state: dict[str, Any], mapping: dict[str, str]) -> dict[str, Any]:
    """
    Dict-shaped sibling of `_build_agent_input`: {destination_key: dotted.state.path}.

    Uses the same `resolve_field_path` as agent `input_fields` and the conditional-edge
    DSL, so every layer of the graph addresses state identically and no new templating
    (or code-execution) surface is introduced.
    """
    return {dest: resolve_field_path(state, path) for dest, path in mapping.items()}


def _field_map(config: dict[str, Any], key: str, node_key: str) -> dict[str, str]:
    mapping = config.get(key) or {}
    if not isinstance(mapping, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in mapping.items()):
        raise ToolNodeConfigError(
            f"Tool node '{node_key}' has a malformed '{key}' — expected a mapping of destination key to dotted state path, "
            f'e.g. {{"vendor": "node_outputs.extract.vendor"}}.'
        )
    return mapping


def _idempotency_config(config: dict[str, Any], node_key: str) -> dict[str, str] | None:
    """
    Validate the optional `idempotency` block.

    Its presence is an ASSERTION BY THE AUTHOR that the target endpoint dedupes
    replays carrying the same key. That assertion is what unlocks retrying a
    mutating call — see `_may_retry`. Absent (the default) is the safe state, so
    nothing existing changes behaviour by upgrading.

    Shape: `{"header": "Idempotency-Key"}`. The header name is configurable
    because there is no standard one — Stripe and the IETF draft say
    `Idempotency-Key`, but ERPs commonly use `X-Request-Id` or a vendor-specific
    name, and a key sent under a header the server ignores is worse than no key
    at all: it looks like a guarantee and is not one.
    """
    raw = config.get("idempotency")
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ToolNodeConfigError(
            f"Tool node '{node_key}' (http_request) has a malformed 'idempotency' — expected an object "
            f'like {{"header": "{DEFAULT_IDEMPOTENCY_HEADER}"}}, got {type(raw).__name__}.'
        )
    header = raw.get("header", DEFAULT_IDEMPOTENCY_HEADER)
    if not isinstance(header, str) or not header.strip():
        raise ToolNodeConfigError(
            f"Tool node '{node_key}' (http_request) has a malformed 'idempotency.header' ({header!r}) — expected a non-empty string."
        )
    return {"header": header.strip()}


def _url_template(config: dict[str, Any], node_key: str) -> tuple[str, dict[str, str]]:
    """
    Validate `url` against `url_fields` so a typo fails at publish, not at 3am.

    The URL may carry `{placeholder}` segments filled from graph state, e.g.
    `https://erp.internal/api/vendors/{vendor_id}` with
    `url_fields: {"vendor_id": "node_outputs.extract.vendor_id"}`. Placeholders
    and mappings must correspond EXACTLY in both directions: an unfilled
    placeholder would be requested literally, and a mapping with no placeholder is
    dead config that reads as if it were wiring something up.

    Added 2026-08-23. The URL used to be entirely static, which made every
    path-parameterised REST endpoint — the ordinary shape of `GET /invoices/{id}`
    — unreachable, and Vol. 5 §1's `erp.get_vendor` step unbuildable against a
    real system.
    """
    url = config.get("url")
    if not url or not isinstance(url, str):
        raise ToolNodeConfigError(
            f"Tool node '{node_key}' (http_request) has no usable 'url' in its config. "
            f"State values reach the URL through '{{placeholder}}' segments mapped by 'url_fields', "
            f"the query string through 'params'/'params_fields', and the body through 'body'/'body_fields'."
        )

    url_fields = _field_map(config, "url_fields", node_key)
    placeholders = set(_URL_PLACEHOLDER_RE.findall(url))

    unfilled = placeholders - url_fields.keys()
    if unfilled:
        raise ToolNodeConfigError(
            f"Tool node '{node_key}' (http_request) has URL placeholder(s) {sorted(unfilled)} with no entry in 'url_fields'. "
            f'Each one needs a dotted state path, e.g. {{"{sorted(unfilled)[0]}": "node_outputs.extract.{sorted(unfilled)[0]}"}}.'
        )

    unused = url_fields.keys() - placeholders
    if unused:
        raise ToolNodeConfigError(
            f"Tool node '{node_key}' (http_request) maps 'url_fields' {sorted(unused)} that appear nowhere in the URL "
            f"{_safe_url(url)!r}. Placeholders must match [a-zA-Z_][a-zA-Z0-9_]* exactly — check for a hyphen or a typo."
        )

    return url, url_fields


def _http_request_config(config: dict[str, Any], node_key: str) -> dict[str, Any]:
    url, url_fields = _url_template(config, node_key)

    method = str(config.get("method", "GET")).upper()
    if method not in _HTTP_METHODS:
        raise ToolNodeConfigError(
            f"Tool node '{node_key}' (http_request) has an unsupported 'method' {method!r}. Supported: {sorted(_HTTP_METHODS)}."
        )

    headers = config.get("headers") or {}
    if not isinstance(headers, dict):
        raise ToolNodeConfigError(f"Tool node '{node_key}' (http_request) has a malformed 'headers' — expected an object.")

    body = config.get("body") or {}
    if not isinstance(body, dict):
        raise ToolNodeConfigError(f"Tool node '{node_key}' (http_request) has a malformed 'body' — expected an object.")

    params = config.get("params") or {}
    if not isinstance(params, dict):
        raise ToolNodeConfigError(f"Tool node '{node_key}' (http_request) has a malformed 'params' — expected an object.")

    return {
        "url": url,
        "url_fields": url_fields,
        "method": method,
        "headers": {str(k): str(v) for k, v in headers.items()},
        "body": body,
        "body_fields": _field_map(config, "body_fields", node_key),
        "params": params,
        "params_fields": _field_map(config, "params_fields", node_key),
        "idempotency": _idempotency_config(config, node_key),
        "timeout_seconds": float(config.get("timeout_seconds", 30.0)),
    }


def _erp_connector_config(config: dict[str, Any], node_key: str) -> dict[str, Any]:
    action = config.get("action")
    if not action or not isinstance(action, str):
        raise ToolNodeConfigError(
            f"Tool node '{node_key}' (erp_connector) has no usable 'action' in its config. Supported: {sorted(_ERP_REQUIRED_PAYLOAD)}."
        )
    if action not in _ERP_REQUIRED_PAYLOAD:
        raise ToolNodeConfigError(
            f"Tool node '{node_key}' (erp_connector) has an unsupported 'action' {action!r}. Supported: {sorted(_ERP_REQUIRED_PAYLOAD)}."
        )

    payload = config.get("payload") or {}
    if not isinstance(payload, dict):
        raise ToolNodeConfigError(f"Tool node '{node_key}' (erp_connector) has a malformed 'payload' — expected an object.")

    return {
        "action": action,
        "payload": payload,
        "payload_fields": _field_map(config, "payload_fields", node_key),
    }


def _knowledge_search_config(config: dict[str, Any], node_key: str) -> dict[str, Any]:
    """
    Validate a `knowledge_search` node's config.

    `knowledge_base_id` is required and is the retrieval TARGET — the direct
    analogue of `http_request`'s `url`, and registry-owned for the same reason
    (see `ToolService.NODE_OVERRIDABLE_KEYS`). The per-usage wiring is the query
    text: a static `query`, or `query_fields` resolving it from graph state via
    the same dotted-path DSL the rest of the graph uses.
    """
    raw_kb_id = config.get("knowledge_base_id")
    if not raw_kb_id or not isinstance(raw_kb_id, str):
        raise ToolNodeConfigError(f"Tool node '{node_key}' (knowledge_search) has no usable 'knowledge_base_id' in its config.")
    try:
        knowledge_base_id = uuid.UUID(raw_kb_id)
    except ValueError as exc:
        raise ToolNodeConfigError(
            f"Tool node '{node_key}' (knowledge_search) has a malformed 'knowledge_base_id' {raw_kb_id!r} — expected a UUID."
        ) from exc

    query = config.get("query") or ""
    if not isinstance(query, str):
        raise ToolNodeConfigError(f"Tool node '{node_key}' (knowledge_search) has a malformed 'query' — expected a string.")

    query_fields = _field_map(config, "query_fields", node_key)
    if not query.strip() and not query_fields:
        raise ToolNodeConfigError(
            f"Tool node '{node_key}' (knowledge_search) has neither a static 'query' nor 'query_fields' to resolve one "
            f'from state, e.g. {{"query": "node_outputs.extract.description"}}.'
        )

    top_k = config.get("top_k")
    if top_k is not None and (not isinstance(top_k, int) or isinstance(top_k, bool) or top_k < 1):
        raise ToolNodeConfigError(f"Tool node '{node_key}' (knowledge_search) has a malformed 'top_k' — expected a positive integer.")

    score_floor = config.get("score_floor")
    if score_floor is not None and (not isinstance(score_floor, int | float) or isinstance(score_floor, bool) or not 0.0 <= score_floor <= 1.0):
        raise ToolNodeConfigError(f"Tool node '{node_key}' (knowledge_search) has a malformed 'score_floor' — expected a number between 0 and 1.")

    return {
        "knowledge_base_id": str(knowledge_base_id),
        "query": query,
        "query_fields": query_fields,
        "top_k": top_k,
        "score_floor": score_floor,
    }


def _notify_config(config: dict[str, Any] | None, node_key: str) -> dict[str, Any]:
    """
    Validate a `notify` node's config.

    Vol. 5 §14/§15/§16 all terminate in a Notify step, and until 2026-08-23 there
    was nothing to compile it to — no NodeType, no handler, and
    `worker_notifications` booting with an empty registry.

    Shipped as a TOOL TYPE rather than a NodeType, following the reasoning
    recorded for `knowledge_search`: a NodeType touches the backend enum, this
    dispatcher, the frontend node catalog, a config form AND
    `lib/graph-validation.ts`, which reimplements the backend rules in a second
    language. A tool type touches this function and inherits the registry picker
    and `tool_executions` auditing already built. A notification is also
    literally what a tool is — a side-effecting call to something outside the
    graph.

    `channel` and `url` are registry-owned (the transport, the direct analogue of
    `http_request`'s `url`); `title`/`body`/`body_fields`/`user_id` are per-usage.
    """
    config = config or {}

    channel = config.get("channel", "in_app")
    if not isinstance(channel, str) or channel not in _NOTIFY_CHANNELS:
        raise ToolNodeConfigError(
            f"Tool node '{node_key}' (notify) has an unsupported 'channel' {channel!r}. "
            f"Supported: {sorted(_NOTIFY_CHANNELS)} — 'email', 'whatsapp' and 'slack' appear in the "
            f"notifications table's vocabulary but have no transport behind them (use 'webhook' for Slack)."
        )

    url = config.get("url")
    if channel == "webhook":
        if not url or not isinstance(url, str):
            raise ToolNodeConfigError(
                f"Tool node '{node_key}' (notify) uses channel 'webhook' but has no 'url' to POST to. "
                f"A Slack/Teams/Zapier incoming-webhook URL goes here — put its token in the tool's secrets."
            )
    elif url:
        raise ToolNodeConfigError(
            f"Tool node '{node_key}' (notify) sets a 'url' on channel {channel!r}, which does not use one. " f"Did you mean channel 'webhook'?"
        )

    title = config.get("title", "")
    body = config.get("body", "")
    for label, value in (("title", title), ("body", body)):
        if not isinstance(value, str):
            raise ToolNodeConfigError(f"Tool node '{node_key}' (notify) has a malformed '{label}' — expected a string.")

    body_fields = _field_map(config, "body_fields", node_key)
    if not title.strip() and not body.strip() and not body_fields:
        raise ToolNodeConfigError(
            f"Tool node '{node_key}' (notify) would send an empty notification — it has no 'title', no 'body' and no "
            f"'body_fields'. A notification nobody can read is worse than no notification, because it looks delivered."
        )

    raw_user = config.get("user_id")
    user_id: str | None = None
    if raw_user:
        try:
            user_id = str(uuid.UUID(str(raw_user)))
        except (ValueError, AttributeError, TypeError) as exc:
            raise ToolNodeConfigError(
                f"Tool node '{node_key}' (notify) has a malformed 'user_id' {raw_user!r} — expected a UUID. "
                f"Omit it entirely to notify the whole organization."
            ) from exc

    return {
        "channel": channel,
        "url": url or None,
        "title": title,
        "body": body,
        "body_fields": body_fields,
        "user_id": user_id,
    }


def _tool_config(config: dict[str, Any] | None, node_key: str) -> dict[str, Any]:
    """
    Validate a tool node's inline config.

    TEMPORARY DENORMALIZATION, mirroring `_agent_config`: the config carries
    `tool_type` and its type-specific settings directly on the node instead of
    resolving `tool_id` against the `tools` table (Vol. 2 §3.3). That table exists
    but the tools module is models-only, so there is nothing to look up yet. When
    that module lands it should resolve `tool_id` into this same shape, leaving this
    handler and the Builder UI's node config panel unchanged.
    """
    config = config or {}

    tool_type = config.get("tool_type")
    if not tool_type or not isinstance(tool_type, str):
        raise ToolNodeConfigError(
            f"Tool node '{node_key}' has no usable 'tool_type' in its config. "
            f"Inline tool config requires 'tool_type' (one of {sorted(_TOOL_TYPES)})"
            + (
                " (a 'tool_id' alone reaches this handler only when it was not resolved against the tools registry — "
                "resolution happens once per run in graph_tasks._resolve_tool_configs, so this is a compile path with no DB)."
                if config.get("tool_id")
                else "."
            )
        )
    if tool_type not in _TOOL_TYPES:
        raise ToolNodeConfigError(
            f"Tool node '{node_key}' has an unsupported 'tool_type' {tool_type!r}. Supported: {sorted(_TOOL_TYPES)} "
            f"(Vol. 2 §7.2 also defines 'python_function' and 'mcp' — neither is implemented yet)."
        )

    # Validated as a real bool because the publish-time approval guardrail in
    # modules/workflows/service.py only recognises a literal `true`; a string
    # "true" would read as non-mutating and silently skip the gate.
    is_mutating = config.get("is_mutating", False)
    if not isinstance(is_mutating, bool):
        raise ToolNodeConfigError(
            f"Tool node '{node_key}' has a malformed 'is_mutating' ({is_mutating!r}) — expected a JSON boolean. "
            f"The publish-time approval guardrail only recognises a literal true."
        )

    # Retrieval reads; it cannot write anywhere. Accepting is_mutating=true would
    # demand a human_approval gate upstream of a pure read at publish time, which
    # devalues the gate by making it routine — the guardrail only means something
    # while every node it fires on genuinely writes to a real system.
    if tool_type == "knowledge_search" and is_mutating:
        raise ToolNodeConfigError(
            f"Tool node '{node_key}' (knowledge_search) sets 'is_mutating': true, but retrieval is read-only. "
            f"Remove the flag — it would force an approval gate upstream of a read."
        )

    # A notification writes nothing an approval could protect: it does not move
    # money, post a journal entry or change a record. Vol. 5's HR workflows put
    # Notify AFTER the gate, so accepting the flag here would demand a SECOND
    # approval to tell someone the first one happened. The guardrail only means
    # something while every node it fires on genuinely writes to a real system.
    if tool_type == "notify" and is_mutating:
        raise ToolNodeConfigError(
            f"Tool node '{node_key}' (notify) sets 'is_mutating': true, but sending a notification changes no "
            f"external record. Remove the flag — it would demand an approval gate in front of telling someone."
        )

    common = {"tool_type": tool_type, "is_mutating": is_mutating}
    if tool_type == "http_request":
        return {**common, **_http_request_config(config, node_key)}
    if tool_type == "knowledge_search":
        return {**common, **_knowledge_search_config(config, node_key)}
    if tool_type == "notify":
        return {**common, **_notify_config(config, node_key)}
    return {**common, **_erp_connector_config(config, node_key)}


def validate_tool_config(config: dict[str, Any] | None, label: str) -> dict[str, Any]:
    """
    Public alias for `_tool_config`, used by the tools registry at write time.

    The point is that a registry row is validated by the exact function that will
    later execute it, so a row that saves is a row that runs — there is no second
    "adapter schema" to keep in sync (Vol. 2 §7.2). It is also what makes the
    registry reject `python_function` and `mcp` at create rather than storing a
    row that only explodes at invoke time, since `_TOOL_TYPES` already rejects
    both by name.

    `label` stands in for the node_key in error messages; callers pass the tool's
    name so a 422 reads sensibly outside a graph.

    Raises ToolNodeConfigError; the service maps it to a 422.
    """
    return _tool_config(config, label)


def _response_payload(response: httpx.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        return response.text


def _safe_url(url: str) -> str:
    """
    Strip the query string before a URL reaches a log line or an error message.

    `?api_key=...` is a common auth pattern, and tool errors land in
    `workflow_runs.error` while log lines are shipped off-box — neither may carry a
    credential (apps/api CLAUDE.md: never log or return raw secrets/API keys).
    """
    base, sep, _ = url.partition("?")
    return f"{base}?<redacted>" if sep else base


def _resolve_url(cfg: dict[str, Any], state: dict[str, Any], node_key: str) -> str:
    """
    Fill the URL template from graph state, percent-encoding every value.

    `quote(..., safe="")` encodes `/`, `?`, `#` and `.` as well, so a state value
    can only ever become ONE path segment. That is the security property here: a
    resolved value of `../../admin/users` becomes `..%2F..%2Fadmin%2Fusers` and
    addresses a (missing) resource rather than escaping the path, and a value
    carrying `?` cannot append a query parameter the author never wrote. State is
    model output and webhook payload — attacker-influenced by construction.

    A placeholder resolving to None raises rather than substituting "None": a URL
    with a hole in it addresses the WRONG resource, and for a mutating tool that
    means writing to the wrong record. Same reasoning for structured values —
    stringifying a dict into a path is never what the author meant. `bool` is
    rejected for the same reason, and separately because `True`/`true`/`1` are
    three different path segments with no obvious winner.
    """
    mapping: dict[str, str] = cfg["url_fields"]
    if not mapping:
        return cfg["url"]

    encoded: dict[str, str] = {}
    for name, path in mapping.items():
        value = resolve_field_path(state, path)
        if value is None:
            raise ToolNodeConfigError(
                f"Tool node '{node_key}' (http_request) could not fill URL placeholder '{{{name}}}': "
                f"state path {path!r} resolved to nothing. The request was not sent — a URL with an "
                f"unresolved segment addresses the wrong resource."
            )
        if isinstance(value, bool | dict | list | tuple):
            raise ToolNodeConfigError(
                f"Tool node '{node_key}' (http_request) resolved URL placeholder '{{{name}}}' from {path!r} to a "
                f"{type(value).__name__}. A URL segment must be a string or a number."
            )
        encoded[name] = quote(str(value), safe="")

    return _URL_PLACEHOLDER_RE.sub(lambda match: encoded[match.group(1)], cfg["url"])


def _resolve_params(cfg: dict[str, Any], state: dict[str, Any], node_key: str) -> dict[str, str]:
    """
    Build the query string from static `params` plus state-resolved `params_fields`.

    Passed to httpx as `params=` rather than concatenated onto the URL, so encoding
    is the transport's job and `_safe_url` keeps working (it strips everything after
    `?`, and the params never appear in `cfg["url"]` to begin with).

    **A value resolving to None is DROPPED, not sent.** An unset optional filter
    means "don't filter", and `?status=None` is a string literal that most APIs
    either reject or, worse, match nothing against. This is the one place the
    treatment differs from `url_fields`, which raises — a missing path segment
    changes which resource is addressed, a missing filter only widens a search.
    """
    merged = {**cfg["params"], **_resolve_field_map(state, cfg["params_fields"])}
    resolved: dict[str, str] = {}
    for key, value in merged.items():
        if value is None:
            continue
        if isinstance(value, dict | list | tuple):
            raise ToolNodeConfigError(
                f"Tool node '{node_key}' (http_request) resolved query parameter {key!r} to a {type(value).__name__}. "
                f"Query values must be scalars."
            )
        resolved[str(key)] = "true" if value is True else "false" if value is False else str(value)
    return resolved


def _idempotency_key(state: dict[str, Any], node_key: str) -> str:
    """
    Deterministic per (run, node) — the same key for every attempt, forever.

    A uuid4 per invocation would survive the retry loop but not a Celery
    redelivery of the same leg, and `_stream_graph` runs once per LEG rather than
    once per run. uuid5 over `run_id:node_key` is stable across both, so a
    server that dedupes on the key sees one logical write no matter how many
    times this code re-executes.
    """
    return str(uuid.uuid5(_IDEMPOTENCY_NAMESPACE, f"{state.get('run_id')}:{node_key}"))


def _may_retry(*, mutating: bool, idempotent: bool, error: Exception | None, status: int | None) -> bool:
    """
    Whether replaying this exact request is safe.

    The rule, added 2026-08-23 after the gap was found while scoping a real ERP
    integration: **a mutating call with no idempotency guarantee is replayed only
    when the request provably never arrived.** Before this, every `http_request`
    node retried 3x on any timeout or 5xx — so a `POST /journal-entries` that the
    ERP committed and then failed to acknowledge inside the timeout was posted
    again, and again, with nothing anywhere reporting a duplicate.

    That hazard was already understood one layer up: `graph_tasks._NON_RETRYABLE`
    carries `ToolExecutionError` precisely so a Celery retry cannot "post the same
    journal entry four times". The same reasoning simply had not been applied to
    this loop, whose 3x was treated as the safe baseline it was not.

    Read-only tools are unaffected — they keep the full retry budget, because
    replaying a GET costs nothing but time.
    """
    if not mutating or idempotent:
        return True
    if status is not None:
        return status in _UNPROCESSED_STATUS
    return isinstance(error, _UNDELIVERED_ERRORS)


def _run_http_request(
    cfg: dict[str, Any],
    state: dict[str, Any],
    node_key: str,
    *,
    client_factory: Callable[..., httpx.Client],
    max_attempts: int,
    retry_base_delay: float,
) -> dict[str, Any]:
    """
    Make one outbound HTTP call, retrying transient failures with exponential backoff.

    Retry shape is copied from `LLMClient._call_with_retry` rather than introducing a
    second mechanism — a hand-rolled loop with `retry_base_delay * 2**attempt`
    (1s, 2s, 4s). tenacity is only a transitive langchain pin, not a declared
    dependency of this project.

    Redirects are resolved by the client before any of this runs (see
    `get_http_client`), so `response.status_code` here is always the status of the
    final hop — a 3xx reaching the classification below would mean the chain
    exceeded `max_redirects`, and it is treated as the definitive answer it then is.

    Status handling splits three ways:
      - 401/403 raise `ToolAuthenticationError` on the first attempt. A credential
        failure returned as node output would be indistinguishable from a business
        404, silently routing the graph down a "not found" branch.
      - Other 4xx are returned as node output rather than raised: they are a
        definitive answer from the server, and Vol. 5 §1 routes on exactly that (the
        "vendor found?" branch after `erp.get_vendor`).
      - 429 and 5xx — where the request never got a real answer — are retried and
        ultimately raised as `ToolExecutionError`.

    **Retrying a mutating call is gated on `_may_retry`** (2026-08-23). The three
    attempts above apply in full to read-only tools; a tool marked `is_mutating`
    with no `idempotency` block is retried only when the request provably never
    landed, and otherwise fails immediately with a message saying so. See
    `_may_retry` for why, and `_idempotency_key` for what makes a replay safe.

    The URL is a template filled by `_resolve_url`, the query string is built by
    `_resolve_params`, and the body merges static `body` with state-resolved
    `body_fields` — all three resolve through the same `resolve_field_path` as the
    condition DSL, so no new templating (or code-execution) surface is introduced.

    The returned dict carries `status_code` and `body` only. Request and response
    headers are deliberately NOT echoed: this value lands in `node_executions.output`,
    which the Execution Viewer renders, and request headers routinely carry an
    Authorization bearer token or API key — now including the idempotency key,
    which is a replay token for a write.
    """
    body = {**cfg["body"], **_resolve_field_map(state, cfg["body_fields"])}
    params = _resolve_params(cfg, state, node_key)
    url = _resolve_url(cfg, state, node_key)
    safe_url = _safe_url(url)

    mutating = bool(cfg.get("is_mutating"))
    idempotency = cfg.get("idempotency")
    headers = dict(cfg["headers"])
    if idempotency is not None:
        headers[idempotency["header"]] = _idempotency_key(state, node_key)

    client = client_factory(timeout=cfg["timeout_seconds"])
    last_error: Exception | None = None
    attempts_made = 0
    try:
        for attempt in range(max_attempts):
            attempts_made = attempt + 1
            last_status: int | None = None
            try:
                response = client.request(cfg["method"], url, headers=headers, params=params or None, json=body or None)
            except _RETRYABLE_HTTP_ERRORS as exc:
                last_error = exc
            else:
                if response.status_code in _AUTH_STATUS:
                    raise ToolAuthenticationError(
                        f"Tool node '{node_key}' was rejected with HTTP {response.status_code} by {cfg['method']} {safe_url}. "
                        f"This is a credential problem, not a business outcome — check the node's configured headers."
                    )
                if response.status_code < 500 and response.status_code not in _RETRYABLE_STATUS:
                    logger.info("Tool node '%s' called %s %s → %d", node_key, cfg["method"], safe_url, response.status_code)
                    return {"status_code": response.status_code, "body": _response_payload(response)}
                last_status = response.status_code
                last_error = ToolExecutionError(f"HTTP {response.status_code} from {cfg['method']} {safe_url}")

            if attempt == max_attempts - 1:
                break
            if not _may_retry(mutating=mutating, idempotent=idempotency is not None, error=last_error, status=last_status):
                raise ToolExecutionError(
                    f"Tool node '{node_key}' failed calling {cfg['method']} {safe_url} and was deliberately NOT retried: "
                    f"the tool is marked 'is_mutating' and declares no 'idempotency', so the server may already have "
                    f"committed this write and a replay would duplicate it. "
                    f"Last error: {type(last_error).__name__}: {last_error}. "
                    f'If the endpoint honours an idempotency key, set config.idempotency to {{"header": "{DEFAULT_IDEMPOTENCY_HEADER}"}} '
                    f"(or whichever header it reads) and retries resume."
                ) from last_error
            delay = retry_base_delay * (2**attempt)
            logger.warning(
                "Transient tool error (%s) on node '%s' attempt %d/%d — retrying in %.1fs: %s",
                type(last_error).__name__,
                node_key,
                attempt + 1,
                max_attempts,
                delay,
                last_error,
            )
            if delay > 0:
                time.sleep(delay)
    finally:
        client.close()

    plural = "attempt" if attempts_made == 1 else "attempts"
    raise ToolExecutionError(
        f"Tool node '{node_key}' failed after {attempts_made} {plural} calling {cfg['method']} {safe_url}. "
        f"Last error: {type(last_error).__name__}: {last_error}"
    ) from last_error


def _run_erp_connector(cfg: dict[str, Any], state: dict[str, Any], node_key: str) -> dict[str, Any]:
    """
    Simulate an ERP write. Makes no network call and touches no external system.

    The resolved payload is echoed back into the result because it is the only record
    of what *would* have been posted — it lands in `node_executions.output` and is the
    audit trail until `tool_executions` is wired (Vol. 4 §4.3 wants that row written
    before execution, which the tools module will own).
    """
    payload = {**cfg["payload"], **_resolve_field_map(state, cfg["payload_fields"])}

    missing = [field for field in _ERP_REQUIRED_PAYLOAD[cfg["action"]] if payload.get(field) is None]
    if missing:
        raise ToolNodeConfigError(
            f"Tool node '{node_key}' (erp_connector/{cfg['action']}) is missing required payload field(s) {missing}. "
            f"Supply them via 'payload', or resolve them from state with 'payload_fields'."
        )

    confirmation_id = f"MOCK-{uuid.uuid4()}"
    logger.info("Tool node '%s' simulated erp_connector/%s → %s", node_key, cfg["action"], confirmation_id)
    return {"posted": True, "confirmation_id": confirmation_id, "action": cfg["action"], "payload": payload}


def _run_knowledge_search(
    cfg: dict[str, Any],
    state: dict[str, Any],
    node_key: str,
    *,
    llm_client_factory: Callable[..., Any],
    search: Callable[..., Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """
    Retrieve chunks from a knowledge base. Returns (node_output, usage).

    Unlike the other two runners this returns usage as well, because embedding
    the query is a real billable OpenAI call. See `tool_handler` for why that
    breaks a previously-documented invariant deliberately.

    **`organization_id` is read from graph state, never from `cfg`.** State is
    seeded by `initial_state_from_trigger` from the run row, which came from the
    authenticated request — so it carries the same provenance guarantee as any
    router's `get_current_org`, while a node config is author-supplied text on a
    canvas. A retrieval node must not be able to name another tenant's org.
    """
    raw_org_id = state.get("organization_id")
    if not raw_org_id:
        raise ToolNodeConfigError(
            f"Tool node '{node_key}' (knowledge_search) ran with no organization_id in graph state. "
            f"State must be built by initial_state_from_trigger, which seeds it from the run row."
        )

    query = cfg["query"]
    resolved = _resolve_field_map(state, cfg["query_fields"])
    # A resolved value wins over the static one: `query` is the fallback an
    # author types while wiring the node, `query_fields` is the live value.
    for value in resolved.values():
        if value is not None and str(value).strip():
            query = str(value)
            break

    if not query.strip():
        raise ToolNodeConfigError(
            f"Tool node '{node_key}' (knowledge_search) resolved an empty query from {sorted(cfg['query_fields'].values())!r} "
            f"and has no static 'query' fallback."
        )

    try:
        result = search(
            organization_id=uuid.UUID(str(raw_org_id)),
            knowledge_base_id=uuid.UUID(cfg["knowledge_base_id"]),
            query=query,
            top_k=cfg.get("top_k"),
            score_floor=cfg.get("score_floor"),
            client_factory=llm_client_factory,
        )
    except LookupError as exc:
        raise ToolNodeConfigError(
            f"Tool node '{node_key}' (knowledge_search) references knowledge base {cfg['knowledge_base_id']}, "
            f"which does not exist in this organization."
        ) from exc

    # An empty hit list is a RESULT, not an error. A query with no match above
    # the floor means the corpus does not answer it, and the agent downstream
    # should be told exactly that so it can say so — raising here would fail the
    # whole run over a question the knowledge base legitimately cannot answer.
    output = {
        "query": query,
        "hit_count": len(result.hits),
        "hits": [
            {
                "document_id": str(hit.document_id),
                "document_name": hit.document_name,
                "chunk_index": hit.chunk_index,
                "content": hit.content,
                "score": round(hit.score, 6),
            }
            for hit in result.hits
        ],
    }
    usage = {
        "tokens_prompt": result.tokens,
        "tokens_completion": 0,
        "cost_usd": result.cost_usd,
        "model": result.model,
    }
    logger.info(
        "Tool node '%s' knowledge_search → %d hit(s), %d tokens, $%.8f",
        node_key,
        len(result.hits),
        result.tokens,
        result.cost_usd,
    )
    return output, usage


def _run_notify(cfg: dict[str, Any], state: dict[str, Any], node_key: str) -> dict[str, Any]:
    """
    Queue one notification. Writes the `notifications` row, then enqueues delivery.

    **Delivery is asynchronous and that is the whole design.** Vol. 5 puts Notify
    at the END of every HR workflow — after the leave is approved, after the
    payroll run is released. Delivering inline would mean a Slack outage fails a
    run whose real work already succeeded and was already approved by a human.
    So the row is committed here (the record that we intended to tell someone,
    the same write-before-execute reasoning as `tool_executions`) and
    `worker_notifications` owns the transport and its retries.

    The node therefore reports `queued`, not `delivered`, and that is honest:
    at this instant nothing has been sent. `notifications.status` is where the
    outcome lands.

    `organization_id` comes from graph state, never from node config — same rule
    and same reason as `knowledge_search`: state is seeded by
    `initial_state_from_trigger` off the run row, so it carries the same
    provenance as a router's `get_current_org`, while node config is author-typed
    text on a canvas.
    """
    organization_id = state.get("organization_id")
    if not organization_id:
        raise ToolNodeConfigError(
            f"Tool node '{node_key}' (notify) ran with no organization_id in graph state. " f"A notification cannot be written without a tenant."
        )

    resolved = _resolve_field_map(state, cfg["body_fields"])
    payload = {
        "title": cfg["title"],
        "body": cfg["body"],
        # Resolved values ride alongside the body rather than being interpolated
        # into it. There is no template syntax anywhere in this codebase and this
        # is not the place to invent one — `{}`-formatting author-supplied text
        # against graph state is a formatting-string injection surface, and the
        # condition DSL's whole design note is that state is ADDRESSED, never
        # evaluated.
        "fields": {k: v for k, v in resolved.items() if v is not None},
        "source": {"node_key": node_key, "run_id": state.get("run_id")},
    }

    from src.modules.notifications.service import queue_notification_sync

    notification_id = queue_notification_sync(
        organization_id=str(organization_id),
        user_id=cfg["user_id"],
        channel=cfg["channel"],
        url=cfg["url"],
        payload=payload,
    )

    logger.info("Tool node '%s' queued %s notification %s", node_key, cfg["channel"], notification_id)
    return {"queued": True, "notification_id": str(notification_id), "channel": cfg["channel"]}


def _audit_input(cfg: dict[str, Any]) -> dict[str, Any]:
    """
    The intent snapshot written to `tool_executions.input`.

    Same redaction rules as node output, and for the same reason — this row is
    audit data an operator will read back. `headers` is dropped outright
    (`tools.config` legitimately holds an Authorization bearer token) and the URL
    is query-stripped, since `?api_key=...` is a common auth pattern.

    Payload/body values are NOT resolved here: resolving them means reading graph
    state, and the point of the intent row is that it is written before anything
    else can fail. The resolved values land in `output` on the way back.
    """
    if cfg["tool_type"] == "http_request":
        # `url` is the TEMPLATE, not the resolved target: this row is written before
        # state is read, which is exactly the property Vol. 4 §4.3 asks for. The
        # `*_fields` maps are recorded because they are author config (dotted paths,
        # not values); static `params` is NOT, for the same reason `headers` is
        # dropped — `?api_key=...` is a common auth pattern and this row is read back
        # by an operator.
        return {
            "tool_type": "http_request",
            "method": cfg["method"],
            "url": _safe_url(cfg["url"]),
            "url_fields": cfg["url_fields"],
            "params_fields": cfg["params_fields"],
            "body_fields": cfg["body_fields"],
            "idempotent": cfg.get("idempotency") is not None,
            "is_mutating": cfg["is_mutating"],
        }
    if cfg["tool_type"] == "notify":
        # `url` is query-stripped for the same reason it is everywhere else: an
        # incoming-webhook URL carries its token in the path or query, and this
        # row is read back by an operator.
        return {
            "tool_type": "notify",
            "channel": cfg["channel"],
            "url": _safe_url(cfg["url"]) if cfg["url"] else None,
            "body_fields": cfg["body_fields"],
            "targeted": cfg["user_id"] is not None,
            "is_mutating": cfg["is_mutating"],
        }
    if cfg["tool_type"] == "knowledge_search":
        # The resolved query is NOT recorded here, for the same reason body/payload
        # values are not: the intent row is written before anything can fail, and
        # resolving means reading state. It lands in `output` on the way back.
        return {
            "tool_type": "knowledge_search",
            "knowledge_base_id": cfg["knowledge_base_id"],
            "query_fields": cfg["query_fields"],
            "is_mutating": cfg["is_mutating"],
        }
    return {
        "tool_type": "erp_connector",
        "action": cfg["action"],
        "payload_fields": cfg["payload_fields"],
        "is_mutating": cfg["is_mutating"],
    }


#: Config keys holding a `{destination: dotted.state.path}` map. Every tool type
#: uses some subset; `_field_map` guarantees each is a dict of str to str.
_FIELD_MAP_KEYS = ("url_fields", "params_fields", "body_fields", "payload_fields", "query_fields")


def _resolved_inputs(cfg: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    """
    The VALUES a tool node read out of state, keyed by the map they came from.

    Deliberately the resolved values, not the paths — the paths are already in
    `tool_executions.input` (written before the call, so it cannot read state)
    and knowing a node was configured to read `node_outputs.extract.total` is no
    help at all when the question is why the request carried a null. This is the
    other half of that pair, and it is what makes a wrong path visible.

    Kept to the declared field maps rather than the whole state: a node's input
    is what it asked for, and dumping the accumulated graph state onto every row
    would grow quadratically with the number of nodes.
    """
    resolved: dict[str, Any] = {}
    for key in _FIELD_MAP_KEYS:
        mapping = cfg.get(key)
        if isinstance(mapping, dict) and mapping:
            resolved[key] = _resolve_field_map(state, mapping)
    return resolved


def tool_handler(
    state: dict[str, Any],
    *,
    node_key: str,
    config: dict[str, Any] | None = None,
    client_factory: Callable[..., httpx.Client] = get_http_client,
    llm_client_factory: Callable[..., Any] = get_llm_client,
    search: Callable[..., Any] | None = None,
    max_attempts: int = 3,
    retry_base_delay: float = 1.0,
    tool_log: Any | None = None,
    tool_id: uuid.UUID | None = None,
) -> dict[str, Any]:
    """
    Execute one `tool`-type node (Vol. 2 §7.2).

    The result is written directly to `node_outputs[node_key]`, same as `agent_handler`,
    so conditional edges can route on paths like `node_outputs.get_vendor.status_code`.

    **Usage reporting is per tool type, and used not to be.** `http_request` and
    `erp_connector` still emit no `node_usage`, so `_usage_for_node` leaves
    tokens/cost NULL on their `node_executions` rows — they spend no LLM money.
    `knowledge_search` DOES: it embeds the query on every call. Reporting NULL
    there would make every RAG run under-report its own cost, and per-run cost is
    a governance claim this product makes out loud. The invariant was a
    description of the two tools that existed, not a principle.

    `client_factory` is the **httpx** factory for `http_request`;
    `llm_client_factory` is the separate OpenAI one, threaded through so a BYOK
    org embeds with its own key. `search` is injected for testability and
    defaults to the real synchronous retrieval path.

    `tool_log`/`tool_id` are supplied together, by the compiler, and only for a node
    the tools registry actually resolved — both are None for inline config and for
    any DB-less compile path, which is what keeps this a no-op on the pre-registry
    path. `tool_id` deliberately does NOT fall back to reading `config["tool_id"]`:
    an inline-config node may carry a stray forward-compat id that resolves to no
    row, and inserting against it would trip the NOT NULL FK.

    When both are present, an intent row is committed BEFORE the call goes out and
    updated with the outcome after (Vol. 4 §4.3). The row's id rides back on the
    `node_tool_calls` channel so `_stream_graph` can back-fill `node_execution_id`
    once that row exists.

    A logging failure must never take down a tool call that otherwise succeeded, so
    `finish` is best-effort; `begin` is not, because a missing intent row would make
    the audit trail silently incomplete, which is worse than a failed run.
    """
    cfg = _tool_config(config, node_key)

    execution_id = None
    if tool_log is not None and tool_id is not None:
        execution_id = tool_log.begin(tool_id, _audit_input(cfg))

    started = time.monotonic()
    usage: dict[str, Any] | None = None
    try:
        if cfg["tool_type"] == "http_request":
            result = _run_http_request(
                cfg,
                state,
                node_key,
                client_factory=client_factory,
                max_attempts=max_attempts,
                retry_base_delay=retry_base_delay,
            )
        elif cfg["tool_type"] == "knowledge_search":
            result, usage = _run_knowledge_search(
                cfg,
                state,
                node_key,
                llm_client_factory=llm_client_factory,
                search=search or _default_search,
            )
        elif cfg["tool_type"] == "notify":
            result = _run_notify(cfg, state, node_key)
        else:
            result = _run_erp_connector(cfg, state, node_key)
    except Exception:
        _finish_quietly(tool_log, execution_id, node_key, status="failed", output=None, started=started)
        raise

    _finish_quietly(tool_log, execution_id, node_key, status="succeeded", output=result, started=started)

    # Copy-then-merge: node_outputs has no reducer, so LangGraph replaces the whole
    # dict on write (same pattern as agent_handler / human_approval_handler).
    update: dict[str, Any] = {"node_outputs": {**state.get("node_outputs", {}), node_key: result}}
    # Only when the node actually reads something declaratively. A tool with no
    # field maps consumed nothing from state, and writing an empty dict would put
    # a row on screen that says "input: {}" as though that were a finding.
    resolved_inputs = _resolved_inputs(cfg, state)
    if resolved_inputs:
        update["node_inputs"] = {**state.get("node_inputs", {}), node_key: resolved_inputs}
    if execution_id is not None:
        update["node_tool_calls"] = {**state.get("node_tool_calls", {}), node_key: [str(execution_id)]}
    if usage is not None:
        update["node_usage"] = {**state.get("node_usage", {}), node_key: usage}
        update["current_cost_usd"] = state.get("current_cost_usd", 0.0) + usage["cost_usd"]
    return update


def _default_search(**kwargs: Any) -> Any:
    """
    Late-bound import of the real retrieval path.

    Imported inside the call rather than at module scope to keep the
    `graphs -> modules.knowledge_base -> db.sync_database` edge out of import
    time. `modules/tools/service.py` already imports this module for
    `validate_tool_config`, and a module-scope import here would drag a second
    database engine into every process that merely validates a tool config.
    """
    from src.modules.knowledge_base.service import search_knowledge_base_sync

    return search_knowledge_base_sync(**kwargs)


def _finish_quietly(
    tool_log: Any | None,
    execution_id: Any,
    node_key: str,
    *,
    status: str,
    output: dict[str, Any] | None,
    started: float,
) -> None:
    if tool_log is None or execution_id is None:
        return
    try:
        tool_log.finish(execution_id, status=status, output=output, latency_ms=int((time.monotonic() - started) * 1000))
    except Exception:  # pragma: no cover - defensive
        logger.exception("Failed to finalize tool_executions row for node '%s'", node_key)


def subgraph_handler(_state: dict[str, Any], *, node_key: str, node_type: str = "subgraph") -> dict[str, Any]:
    raise NodeNotImplementedError(f"Node type '{node_type}' requires the Subgraph module, not yet implemented (node_key={node_key})")
