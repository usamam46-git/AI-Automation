"""
tests/test_workflow_versions.py — Unit and integration tests for workflow version graphs.

Coverage:
- Unit: structural graph validation (valid graph, edge refs, duplicates, start/end, orphans, cycles)
- Integration: draft save/replace, publish lifecycle, cross-tenant isolation, API 422 errors
"""

import uuid

import pytest
from fastapi import status
from httpx import AsyncClient
from test_workflows import create_workflow, create_workspace, register_and_get_token

from src.modules.workflows.schemas import EdgeInput, NodeInput, NodeType
from src.modules.workflows.service import GraphValidationError, validate_graph_structure

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
    assert (
        await client.get(f"/api/v1/workflows/{wf_a['id']}/versions/{version_id}", headers=headers_b)
    ).status_code == 404
    assert (
        await client.post(f"/api/v1/workflows/{wf_a['id']}/versions/{version_id}/publish", headers=headers_b)
    ).status_code == 404


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
