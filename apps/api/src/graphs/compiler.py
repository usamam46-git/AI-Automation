"""
Translate published WorkflowVersion rows into LangGraph CompiledStateGraph objects.

Assumes save/publish-time structural validation already ran — does not re-check cycles,
orphans, or start/end presence. Only compiles versions with published_at set.
"""

from __future__ import annotations

import logging
import operator
import uuid
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any

import redis.asyncio as aioredis
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.types import Command

from src.core.llm_client import LLMClient, get_llm_client
from src.graphs import cache as graph_cache
from src.graphs.condition_eval import evaluate_condition, has_predicate
from src.graphs.node_handlers import (
    agent_handler,
    end_handler,
    human_approval_handler,
    start_handler,
    subgraph_handler,
    tool_handler,
)
from src.modules.workflows.models import WorkflowEdge, WorkflowNode, WorkflowVersion

logger = logging.getLogger(__name__)

CONDITION_NODE_TYPE = "condition"


class DraftVersionCompileError(Exception):
    """Attempted to compile a workflow version that is still a draft."""


class GraphCompileError(Exception):
    """Graph could not be compiled from stored definition."""


def _workflow_state_schema() -> type:
    from typing import TypedDict

    class WorkflowState(TypedDict, total=False):
        run_id: str
        organization_id: str
        trigger_payload: dict[str, Any]
        node_outputs: dict[str, Any]
        # Per-node token/cost bookkeeping, keyed by node_key. Kept as a sibling of
        # node_outputs rather than nested inside it so that bookkeeping never
        # appears on the condition-DSL-addressable surface. The execution engine
        # streams with stream_mode="updates" and only sees what a handler returns,
        # so this is the sole channel by which usage reaches node_executions.
        node_usage: dict[str, Any]
        # tool_executions row ids created by a registry-backed tool node, keyed by
        # node_key. A sibling of node_usage for the same reason and with the same
        # treatment: bookkeeping, stripped from the output snapshot, never on the
        # condition-DSL-addressable surface. _stream_graph reads it to back-fill
        # node_execution_id once the node_executions row exists.
        node_tool_calls: dict[str, Any]
        messages: Annotated[list[Any], operator.add]
        errors: Annotated[list[dict[str, Any]], operator.add]
        current_cost_usd: float

    return WorkflowState


@dataclass(frozen=True)
class CompileStats:
    """Lightweight compile metadata for tests and logging."""

    langgraph_node_count: int
    plain_edge_count: int
    conditional_edge_count: int


def _branch_key(edge: WorkflowEdge, index: int) -> str:
    if edge.condition and edge.condition.get("branch"):
        return str(edge.condition["branch"])
    return edge.target_node_key


def _bind_node_handler(
    node: WorkflowNode,
    *,
    client_factory: Callable[..., LLMClient] = get_llm_client,
    tool_configs: dict[str, dict[str, Any]] | None = None,
    tool_log: Any | None = None,
) -> Callable[..., dict[str, Any]]:
    node_type = node.node_type
    node_key = node.node_key
    if node_type == "start":
        return start_handler
    if node_type == "end":
        return end_handler
    if node_type == "human_approval":

        def _human_approval(state: dict[str, Any]) -> dict[str, Any]:
            return human_approval_handler(state, node_key=node_key)

        return _human_approval
    if node_type == "agent":
        node_config = node.config or {}

        def _agent(state: dict[str, Any]) -> dict[str, Any]:
            return agent_handler(state, node_key=node_key, config=node_config, client_factory=client_factory)

        return _agent
    if node_type == "tool":
        # A registry-resolved config, when one was supplied for this node, replaces
        # the node's own config wholesale — `ToolService.resolve_node_configs` has
        # already folded in the node's overridable keys, and only produces an entry
        # for nodes with no inline `tool_type`. Absent an entry (inline config, or
        # no DB at all as in compile_for_test_run) this is the pre-registry path,
        # byte for byte.
        resolved = (tool_configs or {}).get(node_key)
        tool_config = resolved or node.config or {}
        # Audit logging is bound only for a node the registry actually resolved:
        # tool_executions.tool_id is NOT NULL, and an inline-config node's stray
        # forward-compat tool_id may point at no row at all.
        audit_tool_id = uuid.UUID(str(resolved["tool_id"])) if resolved and resolved.get("tool_id") else None
        audit_log = tool_log if audit_tool_id is not None else None

        def _tool(state: dict[str, Any]) -> dict[str, Any]:
            # `client_factory` is the LLM factory, needed only by knowledge_search
            # (it embeds the query) but bound unconditionally so BYOK resolution
            # reaches every tool type that grows an LLM call later. The httpx
            # factory used by http_request is a separate parameter with its own
            # default inside the handler.
            return tool_handler(
                state,
                node_key=node_key,
                config=tool_config,
                llm_client_factory=client_factory,
                tool_log=audit_log,
                tool_id=audit_tool_id,
            )

        return _tool
    if node_type == "subgraph":

        def _subgraph(state: dict[str, Any]) -> dict[str, Any]:
            return subgraph_handler(state, node_key=node_key, node_type="subgraph")

        return _subgraph
    raise GraphCompileError(f"Unsupported node_type '{node_type}' on node '{node_key}'")


def _log_unresolved_config_refs(nodes: list[WorkflowNode], *, resolved_tool_keys: set[str] | None = None) -> None:
    resolved_tool_keys = resolved_tool_keys or set()
    for node in nodes:
        config = node.config or {}
        # An agent node carrying inline config resolves nothing at runtime, so its
        # agent_id is a forward-compat no-op rather than an unresolved reference —
        # warning on it would fire for every agent node on every compile.
        inline_agent = node.node_type == "agent" and "output_schema" in config
        # Same reasoning for tool nodes: one carrying inline `tool_type` config
        # resolves nothing at runtime, so its tool_id is forward-compat, not an
        # unresolved reference. A node whose tool_id the caller already resolved
        # against the registry is likewise not unresolved — the warning predates
        # the tools module and would now fire on the supported path.
        inline_tool = node.node_type == "tool" and ("tool_type" in config or node.node_key in resolved_tool_keys)
        for ref_key in ("agent_id", "tool_id", "prompt_id"):
            if ref_key == "agent_id" and inline_agent:
                continue
            if ref_key == "tool_id" and inline_tool:
                continue
            if ref_key in config:
                logger.warning(
                    "Compile-time reference check skipped: %s=%s on node '%s' (module not yet implemented)",
                    ref_key,
                    config[ref_key],
                    node.node_key,
                )


#: Sort floor for an edge with no `created_at` — see `_ordered_condition_edges`.
_EDGE_SORT_FLOOR = datetime.min.replace(tzinfo=UTC)


def _ordered_condition_edges(outgoing: list[WorkflowEdge]) -> list[WorkflowEdge]:
    """
    Deterministic evaluation order for one condition node's outgoing edges.

    `router` below is first-match-wins, and `evaluate_condition` returns True for
    an edge with no predicate — so a catch-all fallback edge matches every state.
    Evaluated first, it makes every predicate behind it dead code and the branch
    those predicates guard (typically the human_approval gate) is skipped with
    nothing reporting anything. On a graph whose mutating write sits downstream of
    both branches, that is the difference between a gated post and an unattended one.

    Nothing guaranteed the order before this. The edges arrive in whatever order
    Postgres returned them, and it only ever looked stable because a plain select
    over unmodified rows tends to come back in insertion order. `WorkflowVersion.edges`
    now carries an explicit ORDER BY as well; this sort is the guarantee the router
    itself relies on, and it is kept here rather than at the query so the invariant
    sits next to the loop that depends on it.

    Fallback edges sort last. Within each group the order is (created_at, id):
    `save_draft` deletes and re-inserts every edge of a version in one transaction,
    so `created_at` — a server-side now() — ties across the whole graph, which makes
    the `id` tiebreak load-bearing rather than decorative.
    """

    def sort_key(edge: WorkflowEdge) -> tuple[int, datetime, str]:
        # `created_at` is None on an edge that has not been flushed (every edge in
        # the compiler's own unit tests). Substituting a floor keeps a mixed list
        # sortable instead of raising on a None-vs-datetime comparison, and it is
        # tz-aware because the column is TIMESTAMPTZ.
        created_at = edge.created_at or _EDGE_SORT_FLOOR
        return (0 if has_predicate(edge.condition) else 1, created_at, str(edge.id))

    return sorted(outgoing, key=sort_key)


def _build_condition_router(outgoing: list[WorkflowEdge]) -> tuple[Callable[[dict[str, Any]], str], dict[str, str]]:
    ordered = _ordered_condition_edges(outgoing)

    path_map: dict[str, str] = {}
    for idx, edge in enumerate(ordered):
        path_map[_branch_key(edge, idx)] = edge.target_node_key

    def router(state: dict[str, Any]) -> str:
        for idx, edge in enumerate(ordered):
            branch = _branch_key(edge, idx)
            if evaluate_condition(edge.condition, state):
                return branch
        return _branch_key(ordered[-1], len(ordered) - 1)

    return router, path_map


def _compile_state_graph(
    workflow_version: WorkflowVersion,
    *,
    checkpointer: BaseCheckpointSaver | None = None,
    client_factory: Callable[..., LLMClient] = get_llm_client,
    tool_configs: dict[str, dict[str, Any]] | None = None,
    tool_log: Any | None = None,
) -> tuple[CompiledStateGraph, CompileStats]:
    if workflow_version.published_at is None:
        raise DraftVersionCompileError(f"Workflow version {workflow_version.id} is a draft; only published versions can be compiled.")

    nodes: list[WorkflowNode] = list(workflow_version.nodes)
    edges: list[WorkflowEdge] = list(workflow_version.edges)
    _log_unresolved_config_refs(nodes, resolved_tool_keys=set(tool_configs or {}))

    condition_keys = {n.node_key for n in nodes if n.node_type == CONDITION_NODE_TYPE}
    builder = StateGraph(_workflow_state_schema())

    langgraph_nodes = 0
    for node in nodes:
        if node.node_type == CONDITION_NODE_TYPE:
            continue
        builder.add_node(
            node.node_key,
            _bind_node_handler(node, client_factory=client_factory, tool_configs=tool_configs, tool_log=tool_log),
        )
        langgraph_nodes += 1

    start_nodes = [n for n in nodes if n.node_type == "start"]
    if not start_nodes:
        raise GraphCompileError("Published graph missing start node.")
    builder.add_edge(START, start_nodes[0].node_key)

    for node in nodes:
        if node.node_type == "end":
            builder.add_edge(node.node_key, END)

    edges_by_source: dict[str, list[WorkflowEdge]] = defaultdict(list)
    edges_by_target: dict[str, list[WorkflowEdge]] = defaultdict(list)
    for edge in edges:
        edges_by_source[edge.source_node_key].append(edge)
        edges_by_target[edge.target_node_key].append(edge)

    plain_edge_count = 0
    conditional_edge_count = 0
    conditional_sources_handled: set[str] = set()

    for edge in edges:
        src, tgt = edge.source_node_key, edge.target_node_key
        if src in condition_keys or tgt in condition_keys:
            continue
        builder.add_edge(src, tgt)
        plain_edge_count += 1

    for cond_key in condition_keys:
        outgoing = edges_by_source.get(cond_key, [])
        if not outgoing:
            raise GraphCompileError(f"Condition node '{cond_key}' has no outgoing edges.")
        for incoming in edges_by_target.get(cond_key, []):
            pred = incoming.source_node_key
            if pred in conditional_sources_handled:
                continue
            router, path_map = _build_condition_router(outgoing)
            builder.add_conditional_edges(pred, router, path_map)
            conditional_sources_handled.add(pred)
            conditional_edge_count += 1

    compiled = builder.compile(checkpointer=checkpointer)
    stats = CompileStats(
        langgraph_node_count=langgraph_nodes,
        plain_edge_count=plain_edge_count,
        conditional_edge_count=conditional_edge_count,
    )
    return compiled, stats


async def compile_graph(
    workflow_version: WorkflowVersion,
    redis: aioredis.Redis | None = None,
    *,
    checkpointer: BaseCheckpointSaver | None = None,
) -> CompiledStateGraph:
    """
    Compile a published workflow version, using Redis cache when available.

    Cached graphs are compiled without a checkpointer. For interrupt/resume tests,
    pass checkpointer=MemorySaver() — that bypasses cache read/write.
    """
    if workflow_version.published_at is None:
        raise DraftVersionCompileError(f"Workflow version {workflow_version.id} is a draft; only published versions can be compiled.")

    version_id = str(workflow_version.id)
    use_cache = redis is not None and checkpointer is None

    if use_cache:
        cached = await graph_cache.get_cached_graph(redis, version_id)
        if cached is not None:
            return cached

    compiled, _stats = _compile_state_graph(workflow_version, checkpointer=checkpointer)

    if use_cache:
        await graph_cache.cache_graph(redis, version_id, compiled)

    return compiled


def compile_graph_sync(
    workflow_version: WorkflowVersion,
    *,
    checkpointer: BaseCheckpointSaver | None = None,
) -> CompiledStateGraph:
    """Synchronous compile helper for unit tests (no Redis cache)."""
    compiled, _ = _compile_state_graph(workflow_version, checkpointer=checkpointer)
    return compiled


def initial_state_from_trigger(
    *,
    organization_id: str | uuid.UUID,
    trigger_payload: dict[str, Any] | None = None,
    run_id: str | None = None,
) -> dict[str, Any]:
    return {
        "run_id": run_id or str(uuid.uuid4()),
        "organization_id": str(organization_id),
        "trigger_payload": trigger_payload or {},
        "node_outputs": {},
        "node_usage": {},
        "messages": [],
        "errors": [],
        "current_cost_usd": 0.0,
    }


def run_graph_sync(
    compiled: CompiledStateGraph,
    initial_state: dict[str, Any],
    *,
    thread_id: str = "test-run",
    resume: Any | None = None,
) -> dict[str, Any]:
    """
    Invoke a compiled graph in-process with LangGraph's MemorySaver (tests only).

    Pass resume=... to continue after an interrupt().
    """
    config = {"configurable": {"thread_id": thread_id}}
    if resume is not None:
        return compiled.invoke(Command(resume=resume), config=config)
    return compiled.invoke(initial_state, config=config)


def compile_for_test_run(workflow_version: WorkflowVersion) -> CompiledStateGraph:
    """Compile with in-memory checkpointer so interrupt() works in synchronous tests."""
    return compile_graph_sync(workflow_version, checkpointer=MemorySaver())
