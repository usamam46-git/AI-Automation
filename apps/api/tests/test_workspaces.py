import uuid
from datetime import datetime, timedelta, UTC
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException, status
from httpx import AsyncClient

import src.db.models  # Ensure all mappers are loaded
from src.modules.workspaces.models import Workspace
from src.modules.workspaces.schemas import WorkspaceCreate
from src.modules.workspaces.service import WorkspaceService
from src.modules.workflows.models import Workflow


@pytest.mark.asyncio
async def test_workspace_service_create_default():
    """Unit test: first workspace created gets is_default=True."""
    mock_db = AsyncMock()
    service = WorkspaceService(mock_db)

    # Mock count to return 0 (no workspaces exist)
    service.repository.count_by_org = AsyncMock(return_value=0)

    # Mock create to just return what was passed in as a model
    async def mock_create(org_id, data):
        ws = Workspace(id=uuid.uuid4(), organization_id=org_id, **data)
        return ws

    service.repository.create = AsyncMock(side_effect=mock_create)

    org_id = uuid.uuid4()
    data = WorkspaceCreate(name="Finance")

    result = await service.create_workspace(org_id, data)

    assert result.is_default is True
    assert result.name == "Finance"
    service.repository.count_by_org.assert_called_once_with(org_id)


@pytest.mark.asyncio
async def test_workspace_service_create_non_default():
    """Unit test: subsequent workspaces get is_default=False."""
    mock_db = AsyncMock()
    service = WorkspaceService(mock_db)

    # Mock count to return 1 (workspace already exists)
    service.repository.count_by_org = AsyncMock(return_value=1)

    async def mock_create(org_id, data):
        ws = Workspace(id=uuid.uuid4(), organization_id=org_id, **data)
        return ws

    service.repository.create = AsyncMock(side_effect=mock_create)

    org_id = uuid.uuid4()
    data = WorkspaceCreate(name="HR")

    result = await service.create_workspace(org_id, data)

    assert result.is_default is False
    assert result.name == "HR"


@pytest.mark.asyncio
async def test_workspace_service_delete_blocked():
    """Unit test: deletion blocked if workflows exist."""
    mock_db = AsyncMock()
    service = WorkspaceService(mock_db)

    org_id = uuid.uuid4()
    ws_id = uuid.uuid4()

    service.get_workspace = AsyncMock(return_value=Workspace(id=ws_id, organization_id=org_id))

    # Mock the direct DB execute call for checking workflow count
    mock_result = MagicMock()
    mock_result.scalar_one.return_value = 2  # 2 blocking workflows
    mock_db.execute.return_value = mock_result

    with pytest.raises(HTTPException) as exc:
        await service.delete_workspace(org_id, ws_id)

    assert exc.value.status_code == status.HTTP_409_CONFLICT
    assert "2 non-archived workflow(s)" in exc.value.detail


# --- Integration Tests ---


@pytest.fixture
async def setup_two_orgs(client: AsyncClient):
    uid = uuid.uuid4().hex[:6]
    # Register Org A
    resp_a = await client.post(
        "/api/v1/auth/register",
        json={
            "email": f"owner_a_{uid}@test.com",
            "password": "StrongPassword123!",
            "full_name": "Org A Owner",
            "organization_name": f"Org A {uid}",
        },
    )
    assert resp_a.status_code == 201
    token_a = resp_a.json()["access_token"]

    # Register Org B
    resp_b = await client.post(
        "/api/v1/auth/register",
        json={
            "email": f"owner_b_{uid}@test.com",
            "password": "StrongPassword123!",
            "full_name": "Org B Owner",
            "organization_name": f"Org B {uid}",
        },
    )
    assert resp_b.status_code == 201
    token_b = resp_b.json()["access_token"]

    return {"token_a": token_a, "token_b": token_b}


@pytest.mark.asyncio
async def test_cross_tenant_isolation(client: AsyncClient, setup_two_orgs):
    token_a = setup_two_orgs["token_a"]
    token_b = setup_two_orgs["token_b"]

    headers_a = {"Authorization": f"Bearer {token_a}"}
    headers_b = {"Authorization": f"Bearer {token_b}"}

    # Org A creates a workspace
    resp = await client.post(
        "/api/v1/workspaces",
        json={"name": "Org A Workspace"},
        headers=headers_a,
    )
    assert resp.status_code == 201
    ws_id = resp.json()["id"]

    # Org B attempts to GET it
    resp = await client.get(f"/api/v1/workspaces/{ws_id}", headers=headers_b)
    assert resp.status_code == 404

    # Org B attempts to PATCH it
    resp = await client.patch(f"/api/v1/workspaces/{ws_id}", json={"name": "Hacked"}, headers=headers_b)
    assert resp.status_code == 404

    # Org B attempts to DELETE it
    resp = await client.delete(f"/api/v1/workspaces/{ws_id}", headers=headers_b)
    assert resp.status_code == 404

    # Org A can successfully GET it
    resp = await client.get(f"/api/v1/workspaces/{ws_id}", headers=headers_a)
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_workspace_cursor_pagination(client: AsyncClient, setup_two_orgs):
    token_a = setup_two_orgs["token_a"]
    headers = {"Authorization": f"Bearer {token_a}"}

    # Create 15 workspaces
    for i in range(15):
        resp = await client.post(
            "/api/v1/workspaces",
            json={"name": f"Workspace {i}"},
            headers=headers,
        )
        assert resp.status_code == 201

    # List with limit 10
    resp1 = await client.get("/api/v1/workspaces?limit=10", headers=headers)
    assert resp1.status_code == 200
    page1 = resp1.json()
    assert len(page1) == 10, f"Expected 10, got {len(page1)}"

    # Use the oldest item's created_at as the cursor (last item in DESC order)
    cursor = page1[-1]["created_at"]

    # Fetch next page
    resp2 = await client.get(f"/api/v1/workspaces?limit=10&cursor={cursor}", headers=headers)
    assert resp2.status_code == 200
    page2 = resp2.json()

    # We created 15 + 1 pre-existing = 16 total. Page 1 = 10. Page 2 = 6.
    # The exact number can vary; what matters is: there IS a second page, no overlap.
    assert len(page2) > 0, "Second page should not be empty"

    # Ensure no overlap between pages
    page1_ids = {w["id"] for w in page1}
    page2_ids = {w["id"] for w in page2}
    assert page1_ids.isdisjoint(page2_ids), "Pages must not overlap"

    # Verify all page2 items are older than the cursor
    from datetime import datetime, timezone

    cursor_dt = datetime.fromisoformat(cursor.replace("Z", "+00:00"))
    for w in page2:
        item_dt = datetime.fromisoformat(w["created_at"].replace("Z", "+00:00"))
        assert item_dt <= cursor_dt, f"Item {w['id']} is newer than cursor"


@pytest.mark.asyncio
async def test_workspace_deletion_blocked_integration(client: AsyncClient, setup_two_orgs, session):
    token_a = setup_two_orgs["token_a"]
    headers = {"Authorization": f"Bearer {token_a}"}

    # Create workspace
    resp = await client.post(
        "/api/v1/workspaces",
        json={"name": "Workspace to delete"},
        headers=headers,
    )
    ws_id = resp.json()["id"]
    org_id = resp.json()["organization_id"]

    # Manually insert a workflow into DB
    wf = Workflow(workspace_id=uuid.UUID(ws_id), organization_id=uuid.UUID(org_id), name="Test Workflow", status="draft")
    session.add(wf)
    await session.commit()

    # Attempt delete
    resp = await client.delete(f"/api/v1/workspaces/{ws_id}", headers=headers)
    assert resp.status_code == 409
    assert "1 non-archived workflow(s)" in resp.json()["detail"]

    # Manually archive workflow
    wf.status = "archived"
    await session.commit()

    # Delete should now succeed
    resp = await client.delete(f"/api/v1/workspaces/{ws_id}", headers=headers)
    assert resp.status_code == 204

    # Verify soft delete
    resp = await client.get(f"/api/v1/workspaces/{ws_id}", headers=headers)
    assert resp.status_code == 404
