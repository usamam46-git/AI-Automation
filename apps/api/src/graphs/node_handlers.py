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
import time
import uuid
from collections.abc import Callable
from typing import Any

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
    payload = {
        "type": "approval_request",
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

    messages = [
        {"role": "system", "content": cfg["system_prompt"]},
        {"role": "user", "content": json.dumps(_build_agent_input(state, cfg["input_fields"]), default=str)},
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
_TOOL_TYPES = frozenset({"http_request", "erp_connector"})

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
    """
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


def _http_request_config(config: dict[str, Any], node_key: str) -> dict[str, Any]:
    url = config.get("url")
    if not url or not isinstance(url, str):
        raise ToolNodeConfigError(
            f"Tool node '{node_key}' (http_request) has no usable 'url' in its config. "
            f"The URL is static — state values reach the request through 'body_fields', not through URL interpolation."
        )

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

    return {
        "url": url,
        "method": method,
        "headers": {str(k): str(v) for k, v in headers.items()},
        "body": body,
        "body_fields": _field_map(config, "body_fields", node_key),
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

    common = {"tool_type": tool_type, "is_mutating": is_mutating}
    if tool_type == "http_request":
        return {**common, **_http_request_config(config, node_key)}
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

    Status handling splits three ways:
      - 401/403 raise `ToolAuthenticationError` on the first attempt. A credential
        failure returned as node output would be indistinguishable from a business
        404, silently routing the graph down a "not found" branch.
      - Other 4xx are returned as node output rather than raised: they are a
        definitive answer from the server, and Vol. 5 §1 routes on exactly that (the
        "vendor found?" branch after `erp.get_vendor`).
      - 429 and 5xx — where the request never got a real answer — are retried and
        ultimately raised as `ToolExecutionError`.

    The returned dict carries `status_code` and `body` only. Request and response
    headers are deliberately NOT echoed: this value lands in `node_executions.output`,
    which the Execution Viewer renders, and request headers routinely carry an
    Authorization bearer token or API key.
    """
    body = {**cfg["body"], **_resolve_field_map(state, cfg["body_fields"])}
    client = client_factory(timeout=cfg["timeout_seconds"])
    safe_url = _safe_url(cfg["url"])

    last_error: Exception | None = None
    try:
        for attempt in range(max_attempts):
            try:
                response = client.request(cfg["method"], cfg["url"], headers=cfg["headers"], json=body or None)
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
                last_error = ToolExecutionError(f"HTTP {response.status_code} from {cfg['method']} {safe_url}")

            if attempt == max_attempts - 1:
                break
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

    raise ToolExecutionError(
        f"Tool node '{node_key}' failed after {max_attempts} attempts calling {cfg['method']} {safe_url}. "
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
        return {
            "tool_type": "http_request",
            "method": cfg["method"],
            "url": _safe_url(cfg["url"]),
            "body_fields": cfg["body_fields"],
            "is_mutating": cfg["is_mutating"],
        }
    return {
        "tool_type": "erp_connector",
        "action": cfg["action"],
        "payload_fields": cfg["payload_fields"],
        "is_mutating": cfg["is_mutating"],
    }


def tool_handler(
    state: dict[str, Any],
    *,
    node_key: str,
    config: dict[str, Any] | None = None,
    client_factory: Callable[..., httpx.Client] = get_http_client,
    max_attempts: int = 3,
    retry_base_delay: float = 1.0,
    tool_log: Any | None = None,
    tool_id: uuid.UUID | None = None,
) -> dict[str, Any]:
    """
    Execute one `tool`-type node (Vol. 2 §7.2).

    The result is written directly to `node_outputs[node_key]`, same as `agent_handler`,
    so conditional edges can route on paths like `node_outputs.get_vendor.status_code`.

    Deliberately returns NO `node_usage` entry: tool nodes have no LLM token or cost
    bookkeeping, and `_usage_for_node` in the execution engine therefore leaves
    tokens_prompt/tokens_completion/cost_usd NULL on the node_executions row.

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
        else:
            result = _run_erp_connector(cfg, state, node_key)
    except Exception:
        _finish_quietly(tool_log, execution_id, node_key, status="failed", output=None, started=started)
        raise

    _finish_quietly(tool_log, execution_id, node_key, status="succeeded", output=result, started=started)

    # Copy-then-merge: node_outputs has no reducer, so LangGraph replaces the whole
    # dict on write (same pattern as agent_handler / human_approval_handler).
    update: dict[str, Any] = {"node_outputs": {**state.get("node_outputs", {}), node_key: result}}
    if execution_id is not None:
        update["node_tool_calls"] = {**state.get("node_tool_calls", {}), node_key: [str(execution_id)]}
    return update


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
