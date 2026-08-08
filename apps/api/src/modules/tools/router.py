"""
modules/tools/router.py — /api/v1/tools

Vol. 2 §9.2 lists no tools endpoints, so this surface is derived from §9.1's
conventions: `/api/v1/{resource}`, cursor-based pagination (never offset), and
tenant scope resolved from the auth token rather than the URL. `TOOL_READ` /
`TOOL_WRITE` already existed in the permission vocabulary and are already
granted to Admin and Editor in seed_roles.py — no seeding change was needed.
"""

import uuid
from collections.abc import Sequence

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.dependencies import get_current_org, require_permission
from src.core.permissions import TOOL_READ, TOOL_WRITE
from src.db.database import get_db_session
from src.modules.tools.schemas import ToolCreate, ToolResponse, ToolUpdate
from src.modules.tools.service import ToolService

router = APIRouter(tags=["tools"])


def get_tool_service(db: AsyncSession = Depends(get_db_session)) -> ToolService:
    return ToolService(db)


@router.post(
    "",
    response_model=ToolResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[require_permission(TOOL_WRITE)],
)
async def create_tool(
    data: ToolCreate,
    organization_id: uuid.UUID = Depends(get_current_org),
    service: ToolService = Depends(get_tool_service),
) -> ToolResponse:
    return await service.create_tool(organization_id, data)


@router.get(
    "",
    response_model=Sequence[ToolResponse],
    dependencies=[require_permission(TOOL_READ)],
)
async def list_tools(
    workspace_id: uuid.UUID | None = Query(None, description="Restrict to one workspace."),
    tool_type: str | None = Query(None, description="Restrict to one tool type."),
    cursor: str | None = Query(None, description="Cursor for pagination (ISO datetime string)"),
    limit: int = Query(50, ge=1, le=100),
    organization_id: uuid.UUID = Depends(get_current_org),
    service: ToolService = Depends(get_tool_service),
) -> Sequence[ToolResponse]:
    return await service.list_tools(organization_id, workspace_id, tool_type, cursor, limit)


@router.get(
    "/{tool_id}",
    response_model=ToolResponse,
    dependencies=[require_permission(TOOL_READ)],
)
async def get_tool(
    tool_id: uuid.UUID,
    organization_id: uuid.UUID = Depends(get_current_org),
    service: ToolService = Depends(get_tool_service),
) -> ToolResponse:
    return await service.get_tool(organization_id, tool_id)


@router.patch(
    "/{tool_id}",
    response_model=ToolResponse,
    dependencies=[require_permission(TOOL_WRITE)],
)
async def update_tool(
    tool_id: uuid.UUID,
    data: ToolUpdate,
    organization_id: uuid.UUID = Depends(get_current_org),
    service: ToolService = Depends(get_tool_service),
) -> ToolResponse:
    return await service.update_tool(organization_id, tool_id, data)


@router.delete(
    "/{tool_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[require_permission(TOOL_WRITE)],
)
async def delete_tool(
    tool_id: uuid.UUID,
    organization_id: uuid.UUID = Depends(get_current_org),
    service: ToolService = Depends(get_tool_service),
) -> None:
    await service.delete_tool(organization_id, tool_id)
