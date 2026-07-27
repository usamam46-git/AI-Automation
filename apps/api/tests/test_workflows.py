"""
tests/test_workflows.py — Unit and integration tests for the Workflows module.

Coverage:
- Unit: workspace ownership validation (cross-org → 404)
- Integration: full CRUD, cross-tenant isolation, workspace_id filter, status filter
"""

import uuid
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException, status
from httpx import AsyncClient

from src.modules.workflows.schemas import WorkflowCreate
from src.modules.workflows.service import WorkflowService

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def register_and_get_token(client: AsyncClient, suffix: str = "") -> dict:
    """Register a fresh user+org and return access_token + org/user info."""
    resp = await client.post(
        "/api/v1/auth/register",
        json={
            "email": f"wf_owner_{uuid.uuid4().hex[:6]}@example.com",
            "password": "StrongPassword123!",
            "full_name": "WF Owner",
            "organization_name": f"WF Org {suffix}",
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def create_workspace(client: AsyncClient, token: str, name: str = "Test WS") -> dict:
    resp = await client.post(
        "/api/v1/workspaces",
        json={"name": name},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def create_workflow(client: AsyncClient, token: str, workspace_id: str, name: str = "Test Workflow") -> dict:
    resp = await client.post(
        "/api/v1/workflows",
        json={
            "name": name,
            "workspace_id": workspace_id,
            "trigger_type": "manual",
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# Unit tests (mocked DB)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_workflow_service_rejects_foreign_workspace():
    """Unit test: create_workflow 404s if workspace_id belongs to another org."""
    from unittest.mock import MagicMock

    mock_db = AsyncMock()

    # scalar_one_or_none returns None (workspace not found in org)
    mock_scalar = MagicMock()
    mock_scalar.scalar_one_or_none.return_value = None
    mock_db.execute = AsyncMock(return_value=mock_scalar)

    service = WorkflowService(mock_db)

    org_id = uuid.uuid4()
    data = WorkflowCreate(
        name="Secret Steal",
        workspace_id=uuid.uuid4(),
        trigger_type="manual",
    )

    with pytest.raises(HTTPException) as exc:
        await service.create_workflow(org_id, data)

    assert exc.value.status_code == status.HTTP_404_NOT_FOUND
    assert "Workspace not found" in exc.value.detail


@pytest.mark.asyncio
async def test_workflow_service_get_not_found():
    """Unit test: get_workflow raises 404 for non-existent workflow."""
    from unittest.mock import MagicMock

    mock_db = AsyncMock()

    mock_scalar = MagicMock()
    mock_scalar.scalar_one_or_none.return_value = None
    mock_db.execute = AsyncMock(return_value=mock_scalar)

    service = WorkflowService(mock_db)

    with pytest.raises(HTTPException) as exc:
        await service.get_workflow(uuid.uuid4(), uuid.uuid4())

    assert exc.value.status_code == status.HTTP_404_NOT_FOUND


# ---------------------------------------------------------------------------
# Integration tests (real DB via conftest.py fixtures)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_workflow_create_and_get(client: AsyncClient):
    """Create workspace → create workflow in it → GET workflow by ID."""
    data = await register_and_get_token(client, "A")
    token = data["access_token"]

    ws = await create_workspace(client, token)
    wf = await create_workflow(client, token, ws["id"])

    # GET by ID
    resp = await client.get(
        f"/api/v1/workflows/{wf['id']}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == wf["id"]
    assert body["workspace_id"] == ws["id"]
    assert body["status"] == "draft"
    assert body["current_version_id"] is None  # always null at this stage


@pytest.mark.asyncio
async def test_workflow_list_filter_by_workspace(client: AsyncClient):
    """Create 2 workspaces with 1 workflow each → filter confirms correct scoping."""
    data = await register_and_get_token(client, "B")
    token = data["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    ws1 = await create_workspace(client, token, "WS1")
    ws2 = await create_workspace(client, token, "WS2")

    await create_workflow(client, token, ws1["id"], "WF in WS1")
    await create_workflow(client, token, ws2["id"], "WF in WS2")

    # Filter by ws1
    resp = await client.get(f"/api/v1/workflows?workspace_id={ws1['id']}", headers=headers)
    assert resp.status_code == 200
    results = resp.json()
    assert all(w["workspace_id"] == ws1["id"] for w in results)
    assert len(results) == 1
    assert results[0]["name"] == "WF in WS1"


@pytest.mark.asyncio
async def test_workflow_cross_tenant_workspace_isolation(client: AsyncClient):
    """Org A creates a workspace, Org B tries to create a workflow in it → 404."""
    data_a = await register_and_get_token(client, "C-OrgA")
    data_b = await register_and_get_token(client, "C-OrgB")
    token_a = data_a["access_token"]
    token_b = data_b["access_token"]

    ws_a = await create_workspace(client, token_a, "Org A WS")

    # Org B attempts to use Org A's workspace_id
    resp = await client.post(
        "/api/v1/workflows",
        json={
            "name": "Cross-tenant steal",
            "workspace_id": ws_a["id"],
            "trigger_type": "manual",
        },
        headers={"Authorization": f"Bearer {token_b}"},
    )
    # Must be 404, not 500 or a successful insert
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_workflow_cross_tenant_resource_isolation(client: AsyncClient):
    """Org A creates a workflow, Org B attempts GET/PATCH/DELETE → all 404."""
    data_a = await register_and_get_token(client, "D-OrgA")
    data_b = await register_and_get_token(client, "D-OrgB")
    token_a = data_a["access_token"]
    token_b = data_b["access_token"]
    headers_b = {"Authorization": f"Bearer {token_b}"}

    ws_a = await create_workspace(client, token_a)
    wf_a = await create_workflow(client, token_a, ws_a["id"])
    wf_id = wf_a["id"]

    # GET
    assert (await client.get(f"/api/v1/workflows/{wf_id}", headers=headers_b)).status_code == 404
    # PATCH
    assert (await client.patch(f"/api/v1/workflows/{wf_id}", json={"name": "Hacked"}, headers=headers_b)).status_code == 404
    # DELETE
    assert (await client.delete(f"/api/v1/workflows/{wf_id}", headers=headers_b)).status_code == 404


@pytest.mark.asyncio
async def test_workflow_update(client: AsyncClient):
    """PATCH workflow updates name and status correctly."""
    data = await register_and_get_token(client, "E")
    token = data["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    ws = await create_workspace(client, token)
    wf = await create_workflow(client, token, ws["id"], "Original Name")

    resp = await client.patch(
        f"/api/v1/workflows/{wf['id']}",
        json={"name": "Updated Name", "status": "published"},
        headers=headers,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "Updated Name"
    assert body["status"] == "published"


@pytest.mark.asyncio
async def test_workflow_soft_delete(client: AsyncClient):
    """DELETE archives workflow; subsequent GET returns 404."""
    data = await register_and_get_token(client, "F")
    token = data["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    ws = await create_workspace(client, token)
    wf = await create_workflow(client, token, ws["id"])

    resp = await client.delete(f"/api/v1/workflows/{wf['id']}", headers=headers)
    assert resp.status_code == 204

    resp = await client.get(f"/api/v1/workflows/{wf['id']}", headers=headers)
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_workspace_deletion_blocked_by_workflow(client: AsyncClient):
    """DELETE workspace returns 409 while non-archived workflow exists; succeeds after archive."""
    data = await register_and_get_token(client, "G")
    token = data["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    ws = await create_workspace(client, token)
    wf = await create_workflow(client, token, ws["id"])

    # Should be blocked
    resp = await client.delete(f"/api/v1/workspaces/{ws['id']}", headers=headers)
    assert resp.status_code == 409
    assert "1 non-archived workflow(s)" in resp.json()["detail"]

    # Archive the workflow via the API
    await client.patch(
        f"/api/v1/workflows/{wf['id']}",
        json={"status": "archived"},
        headers=headers,
    )

    # Now workspace deletion should succeed
    resp = await client.delete(f"/api/v1/workspaces/{ws['id']}", headers=headers)
    assert resp.status_code == 204

    resp = await client.get(f"/api/v1/workspaces/{ws['id']}", headers=headers)
    assert resp.status_code == 404
