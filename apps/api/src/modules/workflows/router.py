"""
modules/workflows/router.py — HTTP routes for the Workflow shell and versioned graphs.

Strict layering: router calls service only — no direct DB/repository/ORM imports.
organization_id comes ONLY from get_current_org (JWT context), never request body.
"""

import uuid
from collections.abc import Sequence

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.dependencies import get_audit_context, get_current_org, get_current_user, require_permission
from src.db.database import get_db_session
from src.modules.audit_logs.schemas import AuditContext
from src.modules.auth.models import User
from src.modules.workflows.schemas import (
    WebhookSecretResponse,
    WorkflowCreate,
    WorkflowResponse,
    WorkflowUpdate,
    WorkflowVersionCreate,
    WorkflowVersionResponse,
    WorkflowVersionSummary,
)
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


@router.post(
    "/{workflow_id}/webhook-secret",
    response_model=WebhookSecretResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[require_permission("workflow:publish")],
    summary="Generate or rotate the inbound webhook signing secret",
)
async def rotate_webhook_secret(
    workflow_id: uuid.UUID,
    organization_id: uuid.UUID = Depends(get_current_org),
    audit: AuditContext = Depends(get_audit_context),
    service: WorkflowService = Depends(get_workflow_service),
) -> WebhookSecretResponse:
    """
    Gated on `workflow:publish`, not `workflow:write`. Handing out this secret
    grants a bearer the ability to start production runs of this workflow from
    outside the platform with no login — that is closer to publishing than to
    editing, and `workflow:publish` is already the narrower grant (Editor has
    write but not publish, per seed_roles.py).

    The plaintext appears in this response and nowhere else, ever.
    """
    return await service.rotate_webhook_secret(organization_id, workflow_id, context=audit)


@router.delete(
    "/{workflow_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[require_permission("workflow:write")],
)
async def delete_workflow(
    workflow_id: uuid.UUID,
    organization_id: uuid.UUID = Depends(get_current_org),
    audit: AuditContext = Depends(get_audit_context),
    service: WorkflowService = Depends(get_workflow_service),
) -> None:
    await service.delete_workflow(organization_id, workflow_id, context=audit)


@router.post(
    "/{workflow_id}/versions",
    response_model=WorkflowVersionResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[require_permission("workflow:write")],
)
async def save_workflow_version(
    workflow_id: uuid.UUID,
    data: WorkflowVersionCreate,
    organization_id: uuid.UUID = Depends(get_current_org),
    user: User = Depends(get_current_user),
    service: WorkflowService = Depends(get_workflow_service),
) -> WorkflowVersionResponse:
    return await service.save_draft(organization_id, workflow_id, data, user.id)


@router.get(
    "/{workflow_id}/versions",
    response_model=Sequence[WorkflowVersionSummary],
    dependencies=[require_permission("workflow:read")],
)
async def list_workflow_versions(
    workflow_id: uuid.UUID,
    organization_id: uuid.UUID = Depends(get_current_org),
    service: WorkflowService = Depends(get_workflow_service),
) -> Sequence[WorkflowVersionSummary]:
    return await service.list_versions(organization_id, workflow_id)


@router.get(
    "/{workflow_id}/versions/{version_id}",
    response_model=WorkflowVersionResponse,
    dependencies=[require_permission("workflow:read")],
)
async def get_workflow_version(
    workflow_id: uuid.UUID,
    version_id: uuid.UUID,
    organization_id: uuid.UUID = Depends(get_current_org),
    service: WorkflowService = Depends(get_workflow_service),
) -> WorkflowVersionResponse:
    return await service.get_version(organization_id, workflow_id, version_id)


@router.post(
    "/{workflow_id}/versions/{version_id}/publish",
    response_model=WorkflowVersionResponse,
    dependencies=[require_permission("workflow:publish")],
)
async def publish_workflow_version(
    workflow_id: uuid.UUID,
    version_id: uuid.UUID,
    organization_id: uuid.UUID = Depends(get_current_org),
    user: User = Depends(get_current_user),
    audit: AuditContext = Depends(get_audit_context),
    service: WorkflowService = Depends(get_workflow_service),
) -> WorkflowVersionResponse:
    return await service.publish_version(organization_id, workflow_id, version_id, user.id, context=audit)
