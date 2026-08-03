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
from collections.abc import Callable
from typing import Any

from langgraph.types import interrupt

from src.core.llm_client import LLMClient, get_llm_client
from src.graphs.condition_eval import resolve_field_path

logger = logging.getLogger(__name__)


class NodeNotImplementedError(Exception):
    """Raised when a stub node handler is invoked before its module exists."""


class AgentNodeConfigError(Exception):
    """An agent node's config is missing or malformed — a structural error, never retried."""


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

    `client_factory` is injectable purely so tests can supply a fake without
    patching module globals. BYOK will later pass an org key through it.

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


def tool_handler(_state: dict[str, Any], *, node_key: str, node_type: str = "tool") -> dict[str, Any]:
    raise NodeNotImplementedError(f"Node type '{node_type}' requires the Tool module, not yet implemented (node_key={node_key})")


def subgraph_handler(_state: dict[str, Any], *, node_key: str, node_type: str = "subgraph") -> dict[str, Any]:
    raise NodeNotImplementedError(f"Node type '{node_type}' requires the Subgraph module, not yet implemented (node_key={node_key})")
