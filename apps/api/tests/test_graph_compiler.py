"""
tests/test_graph_compiler.py — Unit and integration tests for the LangGraph compiler.
"""

import uuid
from datetime import UTC, datetime
from unittest.mock import patch

import pytest
from httpx import AsyncClient
from test_workflow_versions import create_workflow, create_workspace, graph_payload, register_and_get_token, valid_graph

from src.core import redis as redis_module
from src.graphs import cache as graph_cache
from src.graphs.cache import cache_graph, get_cached_graph, invalidate_cached_graph
from src.graphs.compiler import (
    DraftVersionCompileError,
    _compile_state_graph,
    compile_for_test_run,
    compile_graph,
    compile_graph_sync,
    initial_state_from_trigger,
    run_graph_sync,
)
from src.graphs.condition_eval import evaluate_condition
from src.graphs.node_handlers import AgentNodeConfigError
from src.modules.workflows.models import WorkflowEdge, WorkflowNode, WorkflowVersion

# ---------------------------------------------------------------------------
# Helpers — lightweight ORM-shaped objects (no DB)
# ---------------------------------------------------------------------------


def _node(key: str, node_type: str, config: dict | None = None) -> WorkflowNode:
    return WorkflowNode(
        id=uuid.uuid4(),
        workflow_version_id=uuid.uuid4(),
        node_key=key,
        node_type=node_type,
        config=config or {},
        position_x=0.0,
        position_y=0.0,
    )


def _edge(source: str, target: str, condition: dict | None = None) -> WorkflowEdge:
    return WorkflowEdge(
        id=uuid.uuid4(),
        workflow_version_id=uuid.uuid4(),
        source_node_key=source,
        target_node_key=target,
        condition=condition,
    )


def _version(*, published: bool, nodes: list[WorkflowNode], edges: list[WorkflowEdge]) -> WorkflowVersion:
    version = WorkflowVersion(
        id=uuid.uuid4(),
        workflow_id=uuid.uuid4(),
        version_number=1,
        graph_definition={"nodes": [], "edges": []},
        published_at=datetime.now(UTC) if published else None,
    )
    version.nodes = nodes
    version.edges = edges
    return version


def _branch_graph() -> WorkflowVersion:
    """start → condition → human_approval → end (single conditional branch)."""
    nodes = [
        _node("start", "start"),
        _node("route", "condition"),
        _node("human_approval", "human_approval"),
        _node("end", "end"),
    ]
    edges = [
        _edge("start", "route"),
        _edge("route", "human_approval", {"field": "trigger_payload.approve", "operator": "eq", "value": True, "branch": "approve"}),
        _edge("human_approval", "end"),
    ]
    return _version(published=True, nodes=nodes, edges=edges)


def _agent_graph() -> WorkflowVersion:
    nodes = [
        _node("start", "start"),
        _node("extract", "agent", {"agent_id": str(uuid.uuid4())}),
        _node("end", "end"),
    ]
    edges = [_edge("start", "extract"), _edge("extract", "end")]
    return _version(published=True, nodes=nodes, edges=edges)


def _interrupt_run_graph() -> WorkflowVersion:
    """start → condition → human_approval → end for synchronous interrupt testing."""
    nodes = [
        _node("start", "start"),
        _node("confidence_check", "condition"),
        _node("human_approval", "human_approval"),
        _node("end", "end"),
    ]
    edges = [
        _edge("start", "confidence_check"),
        _edge(
            "confidence_check",
            "human_approval",
            {"field": "node_outputs.extract.confidence", "operator": "gte", "value": 0.8, "branch": "high"},
        ),
        _edge(
            "confidence_check",
            "end",
            {"field": "node_outputs.extract.confidence", "operator": "lt", "value": 0.8, "branch": "low"},
        ),
        _edge("human_approval", "end"),
    ]
    return _version(published=True, nodes=nodes, edges=edges)


def _realistic_compile_graph() -> WorkflowVersion:
    """Full topology including agent stub (compile-only execution path)."""
    nodes = [
        _node("start", "start"),
        _node("extract", "agent", {"agent_id": str(uuid.uuid4())}),
        _node("confidence_check", "condition"),
        _node("human_approval", "human_approval"),
        _node("end", "end"),
    ]
    edges = [
        _edge("start", "extract"),
        _edge("extract", "confidence_check"),
        _edge(
            "confidence_check",
            "human_approval",
            {"field": "node_outputs.extract.confidence", "operator": "gte", "value": 0.8, "branch": "high"},
        ),
        _edge(
            "confidence_check",
            "end",
            {"field": "node_outputs.extract.confidence", "operator": "lt", "value": 0.8, "branch": "low"},
        ),
        _edge("human_approval", "end"),
    ]
    return _version(published=True, nodes=nodes, edges=edges)


# ---------------------------------------------------------------------------
# Unit — condition evaluation DSL
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("operator", "state", "condition", "result"),
    [
        ("eq", {"node_outputs": {"x": {"v": 1}}}, {"field": "node_outputs.x.v", "operator": "eq", "value": 1}, True),
        ("neq", {"node_outputs": {"x": {"v": 1}}}, {"field": "node_outputs.x.v", "operator": "neq", "value": 2}, True),
        ("gt", {"node_outputs": {"x": {"v": 5}}}, {"field": "node_outputs.x.v", "operator": "gt", "value": 3}, True),
        ("gte", {"node_outputs": {"x": {"v": 5}}}, {"field": "node_outputs.x.v", "operator": "gte", "value": 5}, True),
        ("lt", {"node_outputs": {"x": {"v": 2}}}, {"field": "node_outputs.x.v", "operator": "lt", "value": 5}, True),
        ("lte", {"node_outputs": {"x": {"v": 5}}}, {"field": "node_outputs.x.v", "operator": "lte", "value": 5}, True),
        ("in", {"node_outputs": {"x": {"v": "b"}}}, {"field": "node_outputs.x.v", "operator": "in", "value": ["a", "b"]}, True),
        ("contains", {"node_outputs": {"text": "hello world"}}, {"field": "node_outputs.text", "operator": "contains", "value": "world"}, True),
    ],
)
def test_evaluate_condition_operators(operator, state, condition, result):
    assert evaluate_condition(condition, state) is result


# ---------------------------------------------------------------------------
# Unit — compilation
# ---------------------------------------------------------------------------


def test_compile_branch_graph_node_and_edge_counts():
    version = _branch_graph()
    compiled, stats = _compile_state_graph(version)
    assert compiled is not None
    assert stats.langgraph_node_count == 3  # start, human_approval, end (condition is routing-only)
    assert stats.conditional_edge_count == 1
    assert stats.plain_edge_count == 1  # human_approval → end


def test_compile_draft_version_rejected():
    version = _branch_graph()
    version.published_at = None
    with pytest.raises(DraftVersionCompileError, match="draft"):
        compile_graph_sync(version)


def test_agent_node_with_only_agent_id_raises_config_error():
    """
    An agent node carrying only an opaque `agent_id` still cannot execute.

    This test previously asserted NodeNotImplementedError, because agent_handler
    was a stub. agent_handler is now real, but the agents module is not — there is
    no AgentVersion to resolve `agent_id` against — so such a node must fail loudly
    at invoke time rather than silently calling OpenAI with no prompt or schema.
    The guarantee under test is unchanged; only the exception it surfaces moved.
    """
    version = _agent_graph()
    compiled = compile_for_test_run(version)
    state = initial_state_from_trigger(organization_id=uuid.uuid4())
    with pytest.raises(AgentNodeConfigError, match="system_prompt"):
        run_graph_sync(compiled, state, thread_id="agent-run")


@pytest.mark.asyncio
async def test_compile_graph_cache_hit():
    version = _branch_graph()
    version_id = str(version.id)

    with patch("src.graphs.compiler._compile_state_graph", wraps=_compile_state_graph) as compile_spy:
        r = redis_module.redis_client
        assert r is not None
        first = await compile_graph(version, r)
        second = await compile_graph(version, r)
        assert first is not None
        assert second is not None
        assert compile_spy.call_count == 1

    await invalidate_cached_graph(r, version_id)


@pytest.mark.asyncio
async def test_compile_graph_local_cache_evicts_lru_without_clearing_redis_marker(monkeypatch):
    monkeypatch.setattr(graph_cache, "_LOCAL_COMPILED_GRAPHS", graph_cache.LRUCache(maxsize=3))

    r = redis_module.redis_client
    assert r is not None

    versions = [_branch_graph() for _ in range(4)]
    try:
        for version in versions:
            assert await compile_graph(version, r) is not None

        oldest_id = str(versions[0].id)
        retained_ids = {str(version.id) for version in versions[1:]}

        assert oldest_id not in graph_cache._LOCAL_COMPILED_GRAPHS
        assert set(graph_cache._LOCAL_COMPILED_GRAPHS.keys()) == retained_ids
        assert await r.get(graph_cache._cache_key(oldest_id)) == "1"
    finally:
        for version in versions:
            await invalidate_cached_graph(r, str(version.id))


@pytest.mark.asyncio
async def test_compile_graph_local_cache_eviction_recompiles_on_redis_marker_hit(monkeypatch):
    monkeypatch.setattr(graph_cache, "_LOCAL_COMPILED_GRAPHS", graph_cache.LRUCache(maxsize=3))

    r = redis_module.redis_client
    assert r is not None

    versions = [_branch_graph() for _ in range(4)]
    evicted_id = str(versions[0].id)
    try:
        for version in versions:
            assert await compile_graph(version, r) is not None

        assert evicted_id not in graph_cache._LOCAL_COMPILED_GRAPHS
        assert await r.get(graph_cache._cache_key(evicted_id)) == "1"

        with patch("src.graphs.compiler._compile_state_graph", wraps=_compile_state_graph) as compile_spy:
            assert await compile_graph(versions[0], r) is not None
            assert compile_spy.call_count == 1

        assert await r.get(graph_cache._cache_key(evicted_id)) == "1"
    finally:
        for version in versions:
            await invalidate_cached_graph(r, str(version.id))


def test_realistic_graph_with_agent_compiles():
    version = _realistic_compile_graph()
    compiled, stats = _compile_state_graph(version)
    assert stats.langgraph_node_count == 4  # start, extract, human_approval, end
    assert stats.conditional_edge_count == 1
    assert compiled is not None


def test_interrupt_pauses_at_human_approval():
    version = _interrupt_run_graph()
    compiled = compile_for_test_run(version)
    state = initial_state_from_trigger(
        organization_id=uuid.uuid4(),
        trigger_payload={"invoice_id": "INV-1"},
    )
    state["node_outputs"] = {"extract": {"confidence": 0.95}}

    result = run_graph_sync(compiled, state, thread_id="interrupt-run")
    assert "__interrupt__" in result or compiled.get_state({"configurable": {"thread_id": "interrupt-run"}}).next == ("human_approval",)


# ---------------------------------------------------------------------------
# Integration — cache invalidation via save_draft
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_save_draft_invalidates_compiled_graph_cache(client: AsyncClient, monkeypatch):
    """Replacing an in-place draft clears any compiled-graph cache for that version id."""
    data = await register_and_get_token(client, "GC-cache")
    token = data["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    ws = await create_workspace(client, token)
    wf = await create_workflow(client, token, ws["id"])
    nodes, edges = valid_graph()

    saved = await client.post(
        f"/api/v1/workflows/{wf['id']}/versions",
        json=graph_payload(nodes, edges),
        headers=headers,
    )
    assert saved.status_code == 201
    draft_id = saved.json()["id"]

    # Seed a compiled-graph cache entry for this draft version id
    cached_version = _branch_graph()
    cached_version.id = uuid.UUID(draft_id)
    compiled, _ = _compile_state_graph(cached_version)
    from src.modules.workflows import service as workflow_service

    r = redis_module.redis_client
    assert r is not None
    monkeypatch.setattr(workflow_service, "redis_client", r)
    await cache_graph(r, draft_id, compiled)
    assert await get_cached_graph(r, draft_id) is not None

    # Re-save draft with a different graph — same version row, cache must be invalidated
    nodes_v2, edges_v2 = valid_graph()
    from src.modules.workflows.schemas import EdgeInput, NodeInput, NodeType

    nodes_v2 = [
        NodeInput(node_key="start", node_type=NodeType.start, config={}, position_x=0, position_y=0),
        NodeInput(node_key="tool_step", node_type=NodeType.tool, config={"tool_id": str(uuid.uuid4())}, position_x=100, position_y=0),
        NodeInput(node_key="end", node_type=NodeType.end, config={}, position_x=200, position_y=0),
    ]
    edges_v2 = [
        EdgeInput(source_node_key="start", target_node_key="tool_step"),
        EdgeInput(source_node_key="tool_step", target_node_key="end"),
    ]

    replaced = await client.post(
        f"/api/v1/workflows/{wf['id']}/versions",
        json=graph_payload(nodes_v2, edges_v2),
        headers=headers,
    )
    assert replaced.status_code == 201
    assert replaced.json()["id"] == draft_id
    assert await get_cached_graph(r, draft_id) is None

    await invalidate_cached_graph(r, draft_id)


@pytest.mark.asyncio
async def test_publish_sets_workflow_status(client: AsyncClient):
    data = await register_and_get_token(client, "GC-publish")
    token = data["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    ws = await create_workspace(client, token)
    wf = await create_workflow(client, token, ws["id"])
    nodes, edges = valid_graph()

    saved = await client.post(
        f"/api/v1/workflows/{wf['id']}/versions",
        json=graph_payload(nodes, edges),
        headers=headers,
    )
    version_id = saved.json()["id"]
    await client.post(f"/api/v1/workflows/{wf['id']}/versions/{version_id}/publish", headers=headers)

    wf_resp = await client.get(f"/api/v1/workflows/{wf['id']}", headers=headers)
    assert wf_resp.json()["status"] == "published"
    assert wf_resp.json()["current_version_id"] == version_id
