"""
tests/test_workflow_versions.py — Unit and integration tests for workflow version graphs.

Coverage:
- Unit: structural graph validation (valid graph, edge refs, duplicates, start/end, orphans, cycles)
- Unit: the mutating-tool approval guardrail (Vol. 4 §4.3), publish-only
- Integration: draft save/replace, publish lifecycle, cross-tenant isolation, API 422 errors
"""

import uuid

import pytest
from fastapi import status
from httpx import AsyncClient
from test_workflows import create_workflow, create_workspace, register_and_get_token

from src.modules.workflows.schemas import EdgeInput, NodeInput, NodeType
from src.modules.workflows.service import (
    GraphValidationError,
    validate_draft_structure,
    validate_graph_structure,
    validate_mutating_approval,
)

# ---------------------------------------------------------------------------
# Graph fixtures
# ---------------------------------------------------------------------------


def valid_graph() -> tuple[list[NodeInput], list[EdgeInput]]:
    nodes = [
        NodeInput(node_key="start", node_type=NodeType.start, config={}, position_x=0, position_y=0),
        NodeInput(node_key="agent_1", node_type=NodeType.agent, config={"agent_id": str(uuid.uuid4())}, position_x=100, position_y=0),
        NodeInput(node_key="end", node_type=NodeType.end, config={}, position_x=200, position_y=0),
    ]
    edges = [
        EdgeInput(source_node_key="start", target_node_key="agent_1"),
        EdgeInput(source_node_key="agent_1", target_node_key="end"),
    ]
    return nodes, edges


def graph_payload(nodes: list[NodeInput], edges: list[EdgeInput]) -> dict:
    return {
        "nodes": [node.model_dump(mode="json") for node in nodes],
        "edges": [edge.model_dump(mode="json") for edge in edges],
    }


# ---------------------------------------------------------------------------
# Unit tests — structural validation (no DB)
# ---------------------------------------------------------------------------


def test_validate_graph_structure_valid():
    nodes, edges = valid_graph()
    validate_graph_structure(nodes, edges)


def test_validate_graph_structure_invalid_edge_reference():
    nodes, edges = valid_graph()
    edges.append(EdgeInput(source_node_key="start", target_node_key="missing_node"))
    with pytest.raises(GraphValidationError) as exc:
        validate_graph_structure(nodes, edges)
    assert "nonexistent node_key" in str(exc.value.detail)


def test_validate_graph_structure_duplicate_node_key():
    nodes, edges = valid_graph()
    nodes.append(
        NodeInput(node_key="agent_1", node_type=NodeType.tool, config={}, position_x=50, position_y=50),
    )
    with pytest.raises(GraphValidationError) as exc:
        validate_graph_structure(nodes, edges)
    assert "Duplicate node_key" in str(exc.value.detail)
    assert "agent_1" in str(exc.value.detail)


def test_validate_graph_structure_missing_start_node():
    nodes, edges = valid_graph()
    nodes = [node for node in nodes if node.node_type != NodeType.start]
    edges = [edge for edge in edges if edge.source_node_key != "start"]
    with pytest.raises(GraphValidationError) as exc:
        validate_graph_structure(nodes, edges)
    assert "start node" in str(exc.value.detail)


def test_validate_graph_structure_missing_end_node():
    nodes, edges = valid_graph()
    nodes = [node for node in nodes if node.node_type != NodeType.end]
    edges = [edge for edge in edges if edge.target_node_key != "end"]
    with pytest.raises(GraphValidationError) as exc:
        validate_graph_structure(nodes, edges)
    assert "end node" in str(exc.value.detail)


def test_validate_graph_structure_orphan_node():
    nodes, edges = valid_graph()
    nodes.append(
        NodeInput(node_key="lonely", node_type=NodeType.tool, config={}, position_x=300, position_y=0),
    )
    with pytest.raises(GraphValidationError) as exc:
        validate_graph_structure(nodes, edges)
    assert "Orphan nodes" in str(exc.value.detail)
    assert "lonely" in str(exc.value.detail)


def test_validate_graph_structure_cycle_detected():
    nodes = [
        NodeInput(node_key="start", node_type=NodeType.start, config={}, position_x=0, position_y=0),
        NodeInput(node_key="a", node_type=NodeType.agent, config={}, position_x=100, position_y=0),
        NodeInput(node_key="b", node_type=NodeType.agent, config={}, position_x=200, position_y=0),
        NodeInput(node_key="end", node_type=NodeType.end, config={}, position_x=300, position_y=0),
    ]
    edges = [
        EdgeInput(source_node_key="start", target_node_key="a"),
        EdgeInput(source_node_key="a", target_node_key="b"),
        EdgeInput(source_node_key="b", target_node_key="a"),  # cycle a <-> b
        EdgeInput(source_node_key="b", target_node_key="end"),
    ]
    with pytest.raises(GraphValidationError) as exc:
        validate_graph_structure(nodes, edges)
    assert "Cycle detected" in str(exc.value.detail)


# ---------------------------------------------------------------------------
# Unit tests — draft-safe validation (the Builder canvas autosaves mid-construction)
# ---------------------------------------------------------------------------


def _n(key: str, node_type: NodeType) -> NodeInput:
    return NodeInput(node_key=key, node_type=node_type, config={}, position_x=0, position_y=0)


# Every intermediate state a canvas passes through while a graph is being drawn.
# Each of these violates a *shape* rule and must still be persistable as a draft.
@pytest.mark.parametrize(
    ("label", "nodes", "edges"),
    [
        ("empty canvas", [], []),
        ("one agent node dropped", [_n("agent_1", NodeType.agent)], []),
        ("start and end dropped, not yet connected", [_n("start", NodeType.start), _n("end", NodeType.end)], []),
        (
            "start to agent, no end yet",
            [_n("start", NodeType.start), _n("agent_1", NodeType.agent)],
            [EdgeInput(source_node_key="start", target_node_key="agent_1")],
        ),
        (
            "connected pair plus an unattached node",
            [_n("start", NodeType.start), _n("end", NodeType.end), _n("agent_1", NodeType.agent)],
            [EdgeInput(source_node_key="start", target_node_key="end")],
        ),
        (
            "a cycle mid-rewire",
            [_n("start", NodeType.start), _n("a", NodeType.agent), _n("b", NodeType.agent), _n("end", NodeType.end)],
            [
                EdgeInput(source_node_key="start", target_node_key="a"),
                EdgeInput(source_node_key="a", target_node_key="b"),
                EdgeInput(source_node_key="b", target_node_key="a"),
                EdgeInput(source_node_key="b", target_node_key="end"),
            ],
        ),
    ],
)
def test_validate_draft_structure_allows_partial_graphs(label: str, nodes: list[NodeInput], edges: list[EdgeInput]):
    validate_draft_structure(nodes, edges)  # must not raise
    # Sanity: each of these is genuinely rejected by the strict publish-time rules, so
    # the parametrize list can't silently rot into a set of already-valid graphs and
    # stop proving anything about the split.
    with pytest.raises(GraphValidationError):
        validate_graph_structure(nodes, edges)


def test_validate_draft_structure_rejects_duplicate_node_key():
    """node_key is the identity edges reference — duplicates make the graph ambiguous."""
    nodes = [_n("start", NodeType.start), _n("agent_1", NodeType.agent), _n("agent_1", NodeType.tool)]
    with pytest.raises(GraphValidationError) as exc:
        validate_draft_structure(nodes, [])
    assert "Duplicate node_key" in str(exc.value.detail)
    assert "agent_1" in str(exc.value.detail)


def test_validate_draft_structure_rejects_edge_to_nonexistent_node():
    nodes = [_n("start", NodeType.start)]
    edges = [EdgeInput(source_node_key="start", target_node_key="ghost")]
    with pytest.raises(GraphValidationError) as exc:
        validate_draft_structure(nodes, edges)
    detail = exc.value.detail
    assert isinstance(detail, dict)
    assert detail["invalid_edges"][0]["target_node_key"] == "ghost"


def test_validate_graph_structure_start_and_end_with_no_edges_is_a_validation_error_not_a_crash():
    """
    Regression: `orphan_keys` used to be initialised inside the `for edge in edges` loop,
    so an edgeless graph raised UnboundLocalError and the endpoint returned 500 instead
    of 422. Dropping a start and an end node before connecting them hits this exactly.
    """
    nodes = [_n("start", NodeType.start), _n("end", NodeType.end)]
    with pytest.raises(GraphValidationError) as exc:
        validate_graph_structure(nodes, [])
    assert "Orphan nodes" in str(exc.value.detail)


# ---------------------------------------------------------------------------
# Unit tests — mutating-tool approval guardrail (Vol. 4 §4.3)
# ---------------------------------------------------------------------------

MUTATING_TOOL_CONFIG = {
    "tool_type": "erp_connector",
    "action": "create_journal_entry",
    "is_mutating": True,
    "payload": {"vendor": "Acme", "amount": 10, "account_code": "5000"},
}


def _tool_node(key: str, config: dict) -> NodeInput:
    return NodeInput(node_key=key, node_type=NodeType.tool, config=config, position_x=0, position_y=0)


def approved_mutating_graph() -> tuple[list[NodeInput], list[EdgeInput]]:
    """start → approve → post_je(mutating) → end."""
    nodes = [
        NodeInput(node_key="start", node_type=NodeType.start, config={}, position_x=0, position_y=0),
        NodeInput(node_key="approve", node_type=NodeType.human_approval, config={}, position_x=100, position_y=0),
        _tool_node("post_je", MUTATING_TOOL_CONFIG),
        NodeInput(node_key="end", node_type=NodeType.end, config={}, position_x=300, position_y=0),
    ]
    edges = [
        EdgeInput(source_node_key="start", target_node_key="approve"),
        EdgeInput(source_node_key="approve", target_node_key="post_je"),
        EdgeInput(source_node_key="post_je", target_node_key="end"),
    ]
    return nodes, edges


def unapproved_mutating_graph() -> tuple[list[NodeInput], list[EdgeInput]]:
    """start → post_je(mutating) → end — no approval anywhere."""
    nodes = [
        NodeInput(node_key="start", node_type=NodeType.start, config={}, position_x=0, position_y=0),
        _tool_node("post_je", MUTATING_TOOL_CONFIG),
        NodeInput(node_key="end", node_type=NodeType.end, config={}, position_x=200, position_y=0),
    ]
    edges = [
        EdgeInput(source_node_key="start", target_node_key="post_je"),
        EdgeInput(source_node_key="post_je", target_node_key="end"),
    ]
    return nodes, edges


def test_mutating_node_downstream_of_approval_passes():
    nodes, edges = approved_mutating_graph()
    validate_mutating_approval(nodes, edges)  # must not raise


def test_mutating_node_without_upstream_approval_is_rejected():
    nodes, edges = unapproved_mutating_graph()
    with pytest.raises(GraphValidationError) as exc:
        validate_mutating_approval(nodes, edges)
    assert "no human_approval node" in str(exc.value.detail)
    assert "post_je" in str(exc.value.detail)


def test_non_mutating_tool_without_approval_passes():
    """The gate keys on `is_mutating`, not on node_type — a read-only tool is fine."""
    nodes, edges = unapproved_mutating_graph()
    nodes[1] = _tool_node("post_je", {"tool_type": "http_request", "url": "https://example.com", "is_mutating": False})
    validate_mutating_approval(nodes, edges)


def test_approval_downstream_of_mutating_node_is_rejected():
    """Direction matters: approving *after* the write has already happened is no gate."""
    nodes = [
        NodeInput(node_key="start", node_type=NodeType.start, config={}, position_x=0, position_y=0),
        _tool_node("post_je", MUTATING_TOOL_CONFIG),
        NodeInput(node_key="approve", node_type=NodeType.human_approval, config={}, position_x=200, position_y=0),
        NodeInput(node_key="end", node_type=NodeType.end, config={}, position_x=300, position_y=0),
    ]
    edges = [
        EdgeInput(source_node_key="start", target_node_key="post_je"),
        EdgeInput(source_node_key="post_je", target_node_key="approve"),
        EdgeInput(source_node_key="approve", target_node_key="end"),
    ]
    with pytest.raises(GraphValidationError) as exc:
        validate_mutating_approval(nodes, edges)
    assert "post_je" in str(exc.value.detail)


def test_mutating_node_with_one_approved_branch_passes_exists_semantics():
    """
    THE interpretation test — names which semantics shipped.

    This is Vol. 5 §5 (Journal Validation) verbatim: the non-anomalous branch routes
    straight to the journal-entry write, while the anomalous branch goes through a
    controller review first. Under ∃ semantics ("no approval node ANYWHERE upstream")
    this publishes. Under ∀ semantics ("every path must pass one") it would not — and
    neither would Vol. 5 §1, so the blueprint's own reference workflows would be
    unbuildable.
    """
    nodes = [
        NodeInput(node_key="start", node_type=NodeType.start, config={}, position_x=0, position_y=0),
        NodeInput(node_key="anomaly_check", node_type=NodeType.condition, config={}, position_x=100, position_y=0),
        NodeInput(node_key="approve", node_type=NodeType.human_approval, config={}, position_x=200, position_y=0),
        _tool_node("post_je", MUTATING_TOOL_CONFIG),
        NodeInput(node_key="end", node_type=NodeType.end, config={}, position_x=400, position_y=0),
    ]
    edges = [
        EdgeInput(source_node_key="start", target_node_key="anomaly_check"),
        # anomalous → controller review → post
        EdgeInput(
            source_node_key="anomaly_check",
            target_node_key="approve",
            condition={"field": "node_outputs.anomaly.score", "operator": "gte", "value": 0.8, "branch": "anomalous"},
        ),
        EdgeInput(source_node_key="approve", target_node_key="post_je"),
        # not anomalous → straight to post, no approval on THIS path
        EdgeInput(
            source_node_key="anomaly_check",
            target_node_key="post_je",
            condition={"field": "node_outputs.anomaly.score", "operator": "lt", "value": 0.8, "branch": "clean"},
        ),
        EdgeInput(source_node_key="post_je", target_node_key="end"),
    ]
    validate_mutating_approval(nodes, edges)  # must not raise


def test_approval_reachable_through_a_condition_node_counts():
    """
    Condition rows are traversed by the walk. They exist as stored nodes and are only
    elided later, at compile time — so an approval sitting behind one still guards.
    """
    nodes = [
        NodeInput(node_key="start", node_type=NodeType.start, config={}, position_x=0, position_y=0),
        NodeInput(node_key="approve", node_type=NodeType.human_approval, config={}, position_x=100, position_y=0),
        NodeInput(node_key="route", node_type=NodeType.condition, config={}, position_x=200, position_y=0),
        _tool_node("post_je", MUTATING_TOOL_CONFIG),
        NodeInput(node_key="end", node_type=NodeType.end, config={}, position_x=400, position_y=0),
    ]
    edges = [
        EdgeInput(source_node_key="start", target_node_key="approve"),
        EdgeInput(source_node_key="approve", target_node_key="route"),
        EdgeInput(source_node_key="route", target_node_key="post_je"),
        EdgeInput(source_node_key="post_je", target_node_key="end"),
    ]
    validate_mutating_approval(nodes, edges)


def test_every_offending_node_is_named_not_just_the_first():
    nodes = [
        NodeInput(node_key="start", node_type=NodeType.start, config={}, position_x=0, position_y=0),
        _tool_node("post_je", MUTATING_TOOL_CONFIG),
        _tool_node("release_payment", MUTATING_TOOL_CONFIG),
        NodeInput(node_key="end", node_type=NodeType.end, config={}, position_x=300, position_y=0),
    ]
    edges = [
        EdgeInput(source_node_key="start", target_node_key="post_je"),
        EdgeInput(source_node_key="post_je", target_node_key="release_payment"),
        EdgeInput(source_node_key="release_payment", target_node_key="end"),
    ]
    with pytest.raises(GraphValidationError) as exc:
        validate_mutating_approval(nodes, edges)
    detail = str(exc.value.detail)
    assert "post_je" in detail
    assert "release_payment" in detail


def test_string_true_is_mutating_does_not_trip_the_gate_but_is_rejected_at_runtime():
    """
    Documents the fail-open edge of config-embedded `is_mutating`: only a literal
    JSON true is recognised here. `_tool_config` is what closes it, rejecting a
    non-bool at invoke time (see test_tool_nodes.test_tool_config_error_non_bool_is_mutating).
    """
    from src.graphs.node_handlers import ToolNodeConfigError, tool_handler

    nodes, edges = unapproved_mutating_graph()
    nodes[1] = _tool_node("post_je", {**MUTATING_TOOL_CONFIG, "is_mutating": "true"})

    validate_mutating_approval(nodes, edges)  # gate does not fire...

    with pytest.raises(ToolNodeConfigError, match="malformed 'is_mutating'"):
        tool_handler({}, node_key="post_je", config=nodes[1].config)  # ...but the node cannot run


def test_graph_with_no_mutating_nodes_is_a_no_op():
    nodes, edges = valid_graph()
    validate_mutating_approval(nodes, edges)


# ---------------------------------------------------------------------------
# Integration tests (real DB via conftest.py fixtures)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_save_valid_draft_persists_version_1(client: AsyncClient):
    data = await register_and_get_token(client, "V-A")
    token = data["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    ws = await create_workspace(client, token)
    wf = await create_workflow(client, token, ws["id"])
    nodes, edges = valid_graph()

    resp = await client.post(
        f"/api/v1/workflows/{wf['id']}/versions",
        json=graph_payload(nodes, edges),
        headers=headers,
    )
    assert resp.status_code == status.HTTP_201_CREATED, resp.text
    body = resp.json()
    assert body["version_number"] == 1
    assert body["published_at"] is None
    assert len(body["nodes"]) == 3
    assert len(body["edges"]) == 2


@pytest.mark.asyncio
async def test_save_draft_again_replaces_existing_draft(client: AsyncClient):
    data = await register_and_get_token(client, "V-B")
    token = data["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    ws = await create_workspace(client, token)
    wf = await create_workflow(client, token, ws["id"])
    nodes_v1, edges_v1 = valid_graph()

    first = await client.post(
        f"/api/v1/workflows/{wf['id']}/versions",
        json=graph_payload(nodes_v1, edges_v1),
        headers=headers,
    )
    assert first.status_code == status.HTTP_201_CREATED
    first_id = first.json()["id"]

    nodes_v2 = [
        NodeInput(node_key="start", node_type=NodeType.start, config={}, position_x=0, position_y=0),
        NodeInput(node_key="tool_1", node_type=NodeType.tool, config={"tool_id": str(uuid.uuid4())}, position_x=100, position_y=0),
        NodeInput(node_key="end", node_type=NodeType.end, config={}, position_x=200, position_y=0),
    ]
    edges_v2 = [
        EdgeInput(source_node_key="start", target_node_key="tool_1"),
        EdgeInput(source_node_key="tool_1", target_node_key="end"),
    ]

    second = await client.post(
        f"/api/v1/workflows/{wf['id']}/versions",
        json=graph_payload(nodes_v2, edges_v2),
        headers=headers,
    )
    assert second.status_code == status.HTTP_201_CREATED, second.text
    second_body = second.json()
    assert second_body["id"] == first_id
    assert second_body["version_number"] == 1
    assert any(node["node_key"] == "tool_1" for node in second_body["nodes"])
    assert not any(node["node_key"] == "agent_1" for node in second_body["nodes"])

    listed = await client.get(f"/api/v1/workflows/{wf['id']}/versions", headers=headers)
    assert listed.status_code == 200
    assert len(listed.json()) == 1


@pytest.mark.asyncio
async def test_publish_draft_sets_current_version_and_blocks_modification(client: AsyncClient):
    data = await register_and_get_token(client, "V-C")
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

    published = await client.post(
        f"/api/v1/workflows/{wf['id']}/versions/{version_id}/publish",
        headers=headers,
    )
    assert published.status_code == 200, published.text
    pub_body = published.json()
    assert pub_body["published_at"] is not None
    assert pub_body["published_by"] is not None

    wf_resp = await client.get(f"/api/v1/workflows/{wf['id']}", headers=headers)
    assert wf_resp.json()["current_version_id"] == version_id

    republish = await client.post(
        f"/api/v1/workflows/{wf['id']}/versions/{version_id}/publish",
        headers=headers,
    )
    assert republish.status_code == status.HTTP_409_CONFLICT


@pytest.mark.asyncio
async def test_save_after_publish_creates_version_2(client: AsyncClient):
    data = await register_and_get_token(client, "V-D")
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

    nodes_v2, edges_v2 = valid_graph()
    nodes_v2[1] = NodeInput(
        node_key="agent_2",
        node_type=NodeType.agent,
        config={"agent_id": str(uuid.uuid4())},
        position_x=100,
        position_y=0,
    )
    edges_v2[0] = EdgeInput(source_node_key="start", target_node_key="agent_2")
    edges_v2[1] = EdgeInput(source_node_key="agent_2", target_node_key="end")

    second = await client.post(
        f"/api/v1/workflows/{wf['id']}/versions",
        json=graph_payload(nodes_v2, edges_v2),
        headers=headers,
    )
    assert second.status_code == status.HTTP_201_CREATED, second.text
    assert second.json()["version_number"] == 2
    assert second.json()["published_at"] is None

    listed = await client.get(f"/api/v1/workflows/{wf['id']}/versions", headers=headers)
    assert len(listed.json()) == 2


@pytest.mark.asyncio
async def test_version_cross_tenant_isolation(client: AsyncClient):
    data_a = await register_and_get_token(client, "V-E-A")
    data_b = await register_and_get_token(client, "V-E-B")
    token_a = data_a["access_token"]
    token_b = data_b["access_token"]
    headers_a = {"Authorization": f"Bearer {token_a}"}
    headers_b = {"Authorization": f"Bearer {token_b}"}

    ws_a = await create_workspace(client, token_a)
    wf_a = await create_workflow(client, token_a, ws_a["id"])
    nodes, edges = valid_graph()

    saved = await client.post(
        f"/api/v1/workflows/{wf_a['id']}/versions",
        json=graph_payload(nodes, edges),
        headers=headers_a,
    )
    version_id = saved.json()["id"]

    assert (await client.get(f"/api/v1/workflows/{wf_a['id']}/versions", headers=headers_b)).status_code == 404
    assert (await client.get(f"/api/v1/workflows/{wf_a['id']}/versions/{version_id}", headers=headers_b)).status_code == 404
    assert (await client.post(f"/api/v1/workflows/{wf_a['id']}/versions/{version_id}/publish", headers=headers_b)).status_code == 404


@pytest.mark.asyncio
async def test_invalid_graph_via_api_returns_422(client: AsyncClient):
    data = await register_and_get_token(client, "V-F")
    token = data["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    ws = await create_workspace(client, token)
    wf = await create_workflow(client, token, ws["id"])

    nodes = [
        NodeInput(node_key="start", node_type=NodeType.start, config={}, position_x=0, position_y=0),
        NodeInput(node_key="end", node_type=NodeType.end, config={}, position_x=100, position_y=0),
    ]
    edges = [EdgeInput(source_node_key="start", target_node_key="nonexistent")]

    resp = await client.post(
        f"/api/v1/workflows/{wf['id']}/versions",
        json=graph_payload(nodes, edges),
        headers=headers,
    )
    assert resp.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
    detail = resp.json()["detail"]
    assert "nonexistent node_key" in str(detail)


# ---------------------------------------------------------------------------
# Integration — the mutating-tool approval gate fires at publish, not at save
# ---------------------------------------------------------------------------


async def _save_draft(client: AsyncClient, tag: str, nodes, edges) -> tuple[dict, str, str]:
    data = await register_and_get_token(client, tag)
    token = data["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    ws = await create_workspace(client, token)
    wf = await create_workflow(client, token, ws["id"])

    resp = await client.post(f"/api/v1/workflows/{wf['id']}/versions", json=graph_payload(nodes, edges), headers=headers)
    return headers, wf["id"], resp


@pytest.mark.asyncio
async def test_unapproved_mutating_graph_saves_as_draft_but_fails_to_publish(client: AsyncClient):
    """
    Both halves of the publish-only decision in one test: an author can park a
    half-built graph whose approval gate isn't wired yet (201), but it cannot be
    published (422) with the offending node named.
    """
    nodes, edges = unapproved_mutating_graph()
    headers, workflow_id, saved = await _save_draft(client, "V-MUT-DRAFT", nodes, edges)

    assert saved.status_code == status.HTTP_201_CREATED, saved.text
    version_id = saved.json()["id"]

    published = await client.post(f"/api/v1/workflows/{workflow_id}/versions/{version_id}/publish", headers=headers)
    assert published.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
    detail = str(published.json()["detail"])
    assert "post_je" in detail
    assert "human_approval" in detail


@pytest.mark.asyncio
async def test_approved_mutating_graph_publishes(client: AsyncClient):
    nodes, edges = approved_mutating_graph()
    headers, workflow_id, saved = await _save_draft(client, "V-MUT-OK", nodes, edges)

    assert saved.status_code == status.HTTP_201_CREATED, saved.text
    version_id = saved.json()["id"]

    published = await client.post(f"/api/v1/workflows/{workflow_id}/versions/{version_id}/publish", headers=headers)
    assert published.status_code == status.HTTP_200_OK, published.text
    assert published.json()["published_at"] is not None


# ---------------------------------------------------------------------------
# Integration — structural rules moved to publish, so the Builder can autosave
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_incomplete_graph_saves_as_draft_then_publishes_once_completed(client: AsyncClient):
    """
    The Builder autosave path end to end. A graph is saved at three stages of
    construction — each rejected by the strict publish rules — and only the finished
    graph publishes. Before the draft/publish validation split, the very first save
    returned 500 (edgeless graph -> UnboundLocalError) and the second 422.
    """
    incomplete = [_n("start", NodeType.start), _n("end", NodeType.end)]
    headers, workflow_id, saved = await _save_draft(client, "V-PARTIAL", incomplete, [])
    assert saved.status_code == status.HTTP_201_CREATED, saved.text
    version_id = saved.json()["id"]

    # Publishing the same incomplete graph is still refused, naming both orphans.
    refused = await client.post(f"/api/v1/workflows/{workflow_id}/versions/{version_id}/publish", headers=headers)
    assert refused.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
    assert "Orphan nodes" in str(refused.json()["detail"])

    # Author drops an agent but has only wired the first edge — still saves.
    partial_nodes = [_n("start", NodeType.start), _n("agent_1", NodeType.agent), _n("end", NodeType.end)]
    partial_edges = [EdgeInput(source_node_key="start", target_node_key="agent_1")]
    mid = await client.post(
        f"/api/v1/workflows/{workflow_id}/versions",
        json=graph_payload(partial_nodes, partial_edges),
        headers=headers,
    )
    assert mid.status_code == status.HTTP_201_CREATED, mid.text
    assert mid.json()["id"] == version_id  # replaced the same draft, no version churn

    # Final edge connected — now it publishes.
    complete_edges = [*partial_edges, EdgeInput(source_node_key="agent_1", target_node_key="end")]
    final = await client.post(
        f"/api/v1/workflows/{workflow_id}/versions",
        json=graph_payload(partial_nodes, complete_edges),
        headers=headers,
    )
    assert final.status_code == status.HTTP_201_CREATED, final.text

    published = await client.post(f"/api/v1/workflows/{workflow_id}/versions/{version_id}/publish", headers=headers)
    assert published.status_code == status.HTTP_200_OK, published.text
    assert published.json()["published_at"] is not None


@pytest.mark.asyncio
async def test_draft_save_still_rejects_duplicate_node_key(client: AsyncClient):
    """The data-integrity half of the split is NOT relaxed — this must stay a 422 at save."""
    nodes = [_n("start", NodeType.start), _n("dupe", NodeType.agent), _n("dupe", NodeType.tool)]
    _headers, _workflow_id, saved = await _save_draft(client, "V-DUPE", nodes, [])

    assert saved.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY, saved.text
    assert "Duplicate node_key" in str(saved.json()["detail"])


# ---------------------------------------------------------------------------
# Registry-backed tool nodes at publish (Vol. 4 §4.3, tools module 2026-08-08)
#
# These live here rather than in test_tools.py because this file owns publish
# validation. They pin the half of the mutating gate that reads the `tools`
# table instead of the node's free-form JSONB.
# ---------------------------------------------------------------------------


def _registry_tool_node(key: str, tool_id: str, extra: dict | None = None) -> NodeInput:
    """A tool node that references the registry and carries NO inline tool_type."""
    return _tool_node(key, {"tool_id": tool_id, **(extra or {})})


async def _registry_ctx(client: AsyncClient, suffix: str) -> dict:
    data = await register_and_get_token(client, suffix)
    token = data["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    ws = await create_workspace(client, token)
    wf = await create_workflow(client, token, ws["id"])
    return {"headers": headers, "workspace_id": ws["id"], "workflow_id": wf["id"]}


async def _make_tool(client: AsyncClient, ctx: dict, name: str, *, is_mutating: bool) -> str:
    resp = await client.post(
        "/api/v1/tools",
        json={
            "workspace_id": ctx["workspace_id"],
            "name": name,
            "tool_type": "erp_connector",
            "config": {"action": "create_journal_entry"},
            "is_mutating": is_mutating,
        },
        headers=ctx["headers"],
    )
    assert resp.status_code == status.HTTP_201_CREATED, resp.text
    return resp.json()["id"]


async def _save_and_publish(client: AsyncClient, ctx: dict, nodes, edges):
    saved = await client.post(
        f"/api/v1/workflows/{ctx['workflow_id']}/versions",
        json=graph_payload(nodes, edges),
        headers=ctx["headers"],
    )
    assert saved.status_code == status.HTTP_201_CREATED, saved.text
    version_id = saved.json()["id"]
    return await client.post(
        f"/api/v1/workflows/{ctx['workflow_id']}/versions/{version_id}/publish",
        headers=ctx["headers"],
    )


def _linear(tool_node: NodeInput, *, approved: bool):
    """start → [approve →] tool → end."""
    nodes = [NodeInput(node_key="start", node_type=NodeType.start, config={}, position_x=0, position_y=0)]
    edges = []
    previous = "start"
    if approved:
        nodes.append(NodeInput(node_key="approve", node_type=NodeType.human_approval, config={}, position_x=100, position_y=0))
        edges.append(EdgeInput(source_node_key=previous, target_node_key="approve"))
        previous = "approve"
    nodes.append(tool_node)
    edges.append(EdgeInput(source_node_key=previous, target_node_key=tool_node.node_key))
    nodes.append(NodeInput(node_key="end", node_type=NodeType.end, config={}, position_x=400, position_y=0))
    edges.append(EdgeInput(source_node_key=tool_node.node_key, target_node_key="end"))
    return nodes, edges


def test_registry_mutating_flag_is_ignored_without_the_id_set():
    """
    The widened signature must be a pure no-op by default.

    This is what keeps every pre-registry unit test — and `save_draft`, which
    never passes the argument — behaving exactly as before.
    """
    nodes, edges = _linear(_registry_tool_node("post_je", str(uuid.uuid4())), approved=False)
    validate_mutating_approval(nodes, edges)  # no mutating_tool_ids → no gate


def test_registry_mutating_flag_fires_when_the_id_is_supplied():
    tool_id = uuid.uuid4()
    nodes, edges = _linear(_registry_tool_node("post_je", str(tool_id)), approved=False)

    with pytest.raises(GraphValidationError) as exc:
        validate_mutating_approval(nodes, edges, mutating_tool_ids={tool_id})
    assert "post_je" in str(exc.value.detail)


def test_node_cannot_downgrade_a_mutating_registry_tool():
    """
    Inline config may upgrade a node to mutating, never downgrade it. Without this
    a node could set is_mutating:false and walk past the gate on a tool the org
    explicitly marked as writing to the ledger.
    """
    tool_id = uuid.uuid4()
    node = _registry_tool_node("post_je", str(tool_id), {"is_mutating": False})
    nodes, edges = _linear(node, approved=False)

    with pytest.raises(GraphValidationError) as exc:
        validate_mutating_approval(nodes, edges, mutating_tool_ids={tool_id})
    assert "post_je" in str(exc.value.detail)


def test_malformed_tool_id_is_not_treated_as_a_registry_reference():
    """A non-UUID tool_id must not crash the walk — it reports as unresolvable later."""
    nodes, edges = _linear(_registry_tool_node("post_je", "not-a-uuid"), approved=False)
    validate_mutating_approval(nodes, edges, mutating_tool_ids={uuid.uuid4()})


@pytest.mark.asyncio
async def test_publish_rejects_a_tool_id_with_no_registry_row(client: AsyncClient):
    """
    `tool_id` used to be an opaque UUID with no FK check. Now that a registry
    exists, a dangling reference fails the publish instead of the run.
    """
    ctx = await _registry_ctx(client, "V-REG-MISSING")
    nodes, edges = _linear(_registry_tool_node("post_je", str(uuid.uuid4())), approved=True)

    resp = await _save_and_publish(client, ctx, nodes, edges)
    assert resp.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY, resp.text
    assert "post_je" in str(resp.json()["detail"])
    assert "registry" in str(resp.json()["detail"])


@pytest.mark.asyncio
async def test_publish_rejects_another_orgs_tool_id(client: AsyncClient):
    """Cross-org resolution must fail identically to a nonexistent id — no existence leak."""
    owner = await _registry_ctx(client, "V-REG-OWNER")
    other = await _registry_ctx(client, "V-REG-OTHER")
    foreign_tool_id = await _make_tool(client, other, "foreign_tool", is_mutating=False)

    nodes, edges = _linear(_registry_tool_node("post_je", foreign_tool_id), approved=True)
    resp = await _save_and_publish(client, owner, nodes, edges)

    assert resp.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY, resp.text
    assert "registry" in str(resp.json()["detail"])


@pytest.mark.asyncio
async def test_publish_rejects_unapproved_registry_mutating_tool(client: AsyncClient):
    ctx = await _registry_ctx(client, "V-REG-UNAPPROVED")
    tool_id = await _make_tool(client, ctx, "post_je_tool", is_mutating=True)

    nodes, edges = _linear(_registry_tool_node("post_je", tool_id), approved=False)
    resp = await _save_and_publish(client, ctx, nodes, edges)

    assert resp.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY, resp.text
    assert "no human_approval node" in str(resp.json()["detail"])


@pytest.mark.asyncio
async def test_publish_allows_registry_mutating_tool_behind_an_approval(client: AsyncClient):
    ctx = await _registry_ctx(client, "V-REG-APPROVED")
    tool_id = await _make_tool(client, ctx, "post_je_tool", is_mutating=True)

    nodes, edges = _linear(_registry_tool_node("post_je", tool_id), approved=True)
    resp = await _save_and_publish(client, ctx, nodes, edges)

    assert resp.status_code == status.HTTP_200_OK, resp.text
    assert resp.json()["published_at"] is not None


@pytest.mark.asyncio
async def test_publish_rejects_node_that_downgrades_a_registry_mutating_tool(client: AsyncClient):
    ctx = await _registry_ctx(client, "V-REG-DOWNGRADE")
    tool_id = await _make_tool(client, ctx, "post_je_tool", is_mutating=True)

    node = _registry_tool_node("post_je", tool_id, {"is_mutating": False})
    nodes, edges = _linear(node, approved=False)
    resp = await _save_and_publish(client, ctx, nodes, edges)

    assert resp.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY, resp.text
    assert "no human_approval node" in str(resp.json()["detail"])


@pytest.mark.asyncio
async def test_draft_save_never_resolves_tool_ids(client: AsyncClient):
    """
    Publish-only, like every other gate. An author drops a tool node and wires its
    tool_id afterwards; the canvas autosaves in between and must not 422.
    """
    ctx = await _registry_ctx(client, "V-REG-DRAFT")
    nodes, edges = _linear(_registry_tool_node("post_je", str(uuid.uuid4())), approved=False)

    saved = await client.post(
        f"/api/v1/workflows/{ctx['workflow_id']}/versions",
        json=graph_payload(nodes, edges),
        headers=ctx["headers"],
    )
    assert saved.status_code == status.HTTP_201_CREATED, saved.text


@pytest.mark.asyncio
async def test_inline_configured_node_is_exempt_from_registry_resolution(client: AsyncClient):
    """
    Inline config is the supported non-registry path, and CLAUDE.md documents a
    stray forward-compat `tool_id` alongside it as a no-op. Publishing one must
    not start failing now that a registry exists to check against.
    """
    ctx = await _registry_ctx(client, "V-REG-INLINE")
    node = _tool_node("post_je", {**MUTATING_TOOL_CONFIG, "tool_id": str(uuid.uuid4())})
    nodes, edges = _linear(node, approved=True)

    resp = await _save_and_publish(client, ctx, nodes, edges)
    assert resp.status_code == status.HTTP_200_OK, resp.text
