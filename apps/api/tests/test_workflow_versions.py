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
from src.modules.workflows.service import GraphValidationError, validate_graph_structure, validate_mutating_approval

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
