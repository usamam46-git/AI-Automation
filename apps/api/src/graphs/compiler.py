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
from typing import Annotated, Any

import redis.asyncio as aioredis
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.types import Command

from src.graphs import cache as graph_cache
from src.graphs.condition_eval import evaluate_condition
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


def _bind_node_handler(node: WorkflowNode) -> Callable[..., dict[str, Any]]:
    node_type = node.node_type
    node_key = node.node_key
    if node_type == "start":
        return start_handler
    if node_type == "end":
        return end_handler
    if node_type == "human_approval":
        return human_approval_handler
    if node_type == "agent":

        def _agent(state: dict[str, Any]) -> dict[str, Any]:
            return agent_handler(state, node_key=node_key, node_type="agent")

        return _agent
    if node_type == "tool":

        def _tool(state: dict[str, Any]) -> dict[str, Any]:
            return tool_handler(state, node_key=node_key, node_type="tool")

        return _tool
    if node_type == "subgraph":

        def _subgraph(state: dict[str, Any]) -> dict[str, Any]:
            return subgraph_handler(state, node_key=node_key, node_type="subgraph")

        return _subgraph
    raise GraphCompileError(f"Unsupported node_type '{node_type}' on node '{node_key}'")


def _log_unresolved_config_refs(nodes: list[WorkflowNode]) -> None:
    for node in nodes:
        config = node.config or {}
        for ref_key in ("agent_id", "tool_id", "prompt_id"):
            if ref_key in config:
                logger.warning(
                    "Compile-time reference check skipped: %s=%s on node '%s' (module not yet implemented)",
                    ref_key,
                    config[ref_key],
                    node.node_key,
                )


def _build_condition_router(outgoing: list[WorkflowEdge]) -> tuple[Callable[[dict[str, Any]], str], dict[str, str]]:
    path_map: dict[str, str] = {}
    for idx, edge in enumerate(outgoing):
        path_map[_branch_key(edge, idx)] = edge.target_node_key

    def router(state: dict[str, Any]) -> str:
        for idx, edge in enumerate(outgoing):
            branch = _branch_key(edge, idx)
            if evaluate_condition(edge.condition, state):
                return branch
        return _branch_key(outgoing[-1], len(outgoing) - 1)

    return router, path_map


def _compile_state_graph(
    workflow_version: WorkflowVersion,
    *,
    checkpointer: BaseCheckpointSaver | None = None,
) -> tuple[CompiledStateGraph, CompileStats]:
    if workflow_version.published_at is None:
        raise DraftVersionCompileError(f"Workflow version {workflow_version.id} is a draft; only published versions can be compiled.")

    nodes: list[WorkflowNode] = list(workflow_version.nodes)
    edges: list[WorkflowEdge] = list(workflow_version.edges)
    _log_unresolved_config_refs(nodes)

    condition_keys = {n.node_key for n in nodes if n.node_type == CONDITION_NODE_TYPE}
    builder = StateGraph(_workflow_state_schema())

    langgraph_nodes = 0
    for node in nodes:
        if node.node_type == CONDITION_NODE_TYPE:
            continue
        builder.add_node(node.node_key, _bind_node_handler(node))
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
