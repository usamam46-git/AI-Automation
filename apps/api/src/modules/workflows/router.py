"""
modules/workflows/router.py — HTTP routes for the Workflow shell.

Strict layering: router calls service only — no direct DB/repository/ORM imports.
organization_id comes ONLY from get_current_org (JWT context), never request body.
"""

import uuid
from collections.abc import Sequence

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.dependencies import get_current_org, require_permission
from src.db.database import get_db_session
from src.modules.workflows.schemas import WorkflowCreate, WorkflowResponse, WorkflowUpdate
from src.modules.workflows.service import WorkflowService

router = APIRouter(tags=["workflows"])


def get_workflow_service(db: AsyncSession = Depends(get_db_session)) -> WorkflowService:
    return WorkflowService(db)


@router.post(
    "",
    response_model=WorkflowResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[require_permission("workflow:write")],
)
async def create_workflow(
    data: WorkflowCreate,
    organization_id: uuid.UUID = Depends(get_current_org),
    service: WorkflowService = Depends(get_workflow_service),
) -> WorkflowResponse:
    return await service.create_workflow(organization_id, data)


@router.get(
    "",
    response_model=Sequence[WorkflowResponse],
    dependencies=[require_permission("workflow:read")],
)
async def list_workflows(
    workspace_id: uuid.UUID | None = Query(None, description="Filter by workspace"),
    status: str | None = Query(None, description="Filter by status (draft|published|archived)"),
    cursor: str | None = Query(None, description="Cursor for pagination (ISO datetime string)"),
    limit: int = Query(50, ge=1, le=100),
    organization_id: uuid.UUID = Depends(get_current_org),
    service: WorkflowService = Depends(get_workflow_service),
) -> Sequence[WorkflowResponse]:
    return await service.list_workflows(
        organization_id,
        workspace_id=workspace_id,
        status_filter=status,
        cursor=cursor,
        limit=limit,
    )


@router.get(
    "/{workflow_id}",
    response_model=WorkflowResponse,
    dependencies=[require_permission("workflow:read")],
)
async def get_workflow(
    workflow_id: uuid.UUID,
    organization_id: uuid.UUID = Depends(get_current_org),
    service: WorkflowService = Depends(get_workflow_service),
) -> WorkflowResponse:
    return await service.get_workflow(organization_id, workflow_id)


@router.patch(
    "/{workflow_id}",
    response_model=WorkflowResponse,
    dependencies=[require_permission("workflow:write")],
)
async def update_workflow(
    workflow_id: uuid.UUID,
    data: WorkflowUpdate,
    organization_id: uuid.UUID = Depends(get_current_org),
    service: WorkflowService = Depends(get_workflow_service),
) -> WorkflowResponse:
    return await service.update_workflow(organization_id, workflow_id, data)


@router.delete(
    "/{workflow_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[require_permission("workflow:write")],
)
async def delete_workflow(
    workflow_id: uuid.UUID,
    organization_id: uuid.UUID = Depends(get_current_org),
    service: WorkflowService = Depends(get_workflow_service),
) -> None:
    await service.delete_workflow(organization_id, workflow_id)
