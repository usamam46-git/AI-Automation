import uuid
from collections.abc import Sequence

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.dependencies import get_current_org, require_permission
from src.db.database import get_db_session
from src.modules.workspaces.schemas import WorkspaceCreate, WorkspaceResponse, WorkspaceUpdate
from src.modules.workspaces.service import WorkspaceService

router = APIRouter(tags=["workspaces"])


def get_workspace_service(db: AsyncSession = Depends(get_db_session)) -> WorkspaceService:
    return WorkspaceService(db)


@router.post(
    "",
    response_model=WorkspaceResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[require_permission("workspace:write")],
)
async def create_workspace(
    data: WorkspaceCreate,
    organization_id: uuid.UUID = Depends(get_current_org),
    service: WorkspaceService = Depends(get_workspace_service),
) -> WorkspaceResponse:
    return await service.create_workspace(organization_id, data)


@router.get(
    "",
    response_model=Sequence[WorkspaceResponse],
    dependencies=[require_permission("workspace:read")],
)
async def list_workspaces(
    cursor: str | None = Query(None, description="Cursor for pagination (ISO datetime string)"),
    limit: int = Query(50, ge=1, le=100),
    organization_id: uuid.UUID = Depends(get_current_org),
    service: WorkspaceService = Depends(get_workspace_service),
) -> Sequence[WorkspaceResponse]:
    return await service.list_workspaces(organization_id, cursor, limit)


@router.get(
    "/{workspace_id}",
    response_model=WorkspaceResponse,
    dependencies=[require_permission("workspace:read")],
)
async def get_workspace(
    workspace_id: uuid.UUID,
    organization_id: uuid.UUID = Depends(get_current_org),
    service: WorkspaceService = Depends(get_workspace_service),
) -> WorkspaceResponse:
    return await service.get_workspace(organization_id, workspace_id)


@router.patch(
    "/{workspace_id}",
    response_model=WorkspaceResponse,
    dependencies=[require_permission("workspace:write")],
)
async def update_workspace(
    workspace_id: uuid.UUID,
    data: WorkspaceUpdate,
    organization_id: uuid.UUID = Depends(get_current_org),
    service: WorkspaceService = Depends(get_workspace_service),
) -> WorkspaceResponse:
    return await service.update_workspace(organization_id, workspace_id, data)


@router.delete(
    "/{workspace_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[require_permission("workspace:write")],
)
async def delete_workspace(
    workspace_id: uuid.UUID,
    organization_id: uuid.UUID = Depends(get_current_org),
    service: WorkspaceService = Depends(get_workspace_service),
) -> None:
    await service.delete_workspace(organization_id, workspace_id)
