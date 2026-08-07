"""
modules/executions/router.py — HTTP routes for workflow execution.

Endpoints:
  POST /api/v1/workflows/{workflow_id}/run      — trigger a run
  GET  /api/v1/executions                       — list runs (cursor-paginated)
  GET  /api/v1/executions/{run_id}              — poll run status
  POST /api/v1/executions/{run_id}/resume       — approve or reject a waiting run

Strict layering: router calls service only — zero business logic, zero direct DB/ORM.
organization_id comes ONLY from get_current_org (JWT), never from request body.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.dependencies import get_current_org, require_permission
from src.db.database import get_db_session
from src.modules.executions.schemas import (
    ResumeRequest,
    RunTriggerRequest,
    WorkflowRunResponse,
    WorkflowRunSummary,
)
from src.modules.executions.service import ExecutionService

router = APIRouter(tags=["executions"])


def _get_service(db: AsyncSession = Depends(get_db_session)) -> ExecutionService:
    return ExecutionService(db)


@router.post(
    "/workflows/{workflow_id}/run",
    response_model=WorkflowRunResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[require_permission("workflow:execute")],
    summary="Trigger a workflow run",
)
async def trigger_run(
    workflow_id: uuid.UUID,
    body: RunTriggerRequest,
    org_id: uuid.UUID = Depends(get_current_org),
    svc: ExecutionService = Depends(_get_service),
) -> WorkflowRunResponse:
    return await svc.trigger_run(org_id, workflow_id, body)


@router.get(
    "/executions",
    response_model=Sequence[WorkflowRunSummary],
    dependencies=[require_permission("execution:read")],
    summary="List execution runs for the org",
)
async def list_runs(
    workflow_id: uuid.UUID | None = Query(None, description="Filter by workflow"),
    status: str | None = Query(None, description="Filter by run status (pending|running|waiting_approval|completed|failed|cancelled|rejected)"),
    cursor: str | None = Query(None, description="Cursor for pagination (ISO datetime string)"),
    limit: int = Query(50, ge=1, le=100),
    org_id: uuid.UUID = Depends(get_current_org),
    svc: ExecutionService = Depends(_get_service),
) -> Sequence[WorkflowRunSummary]:
    return await svc.list_runs(
        org_id,
        workflow_id=workflow_id,
        status_filter=status,
        cursor=cursor,
        limit=limit,
    )


@router.get(
    "/executions/{run_id}",
    response_model=WorkflowRunResponse,
    dependencies=[require_permission("execution:read")],
    summary="Get execution run status and node history",
)
async def get_run(
    run_id: uuid.UUID,
    org_id: uuid.UUID = Depends(get_current_org),
    svc: ExecutionService = Depends(_get_service),
) -> WorkflowRunResponse:
    return await svc.get_run(org_id, run_id)


@router.post(
    "/executions/{run_id}/resume",
    response_model=WorkflowRunResponse,
    dependencies=[require_permission("execution:approve")],
    summary="Approve or reject a waiting_approval run",
)
async def resume_run(
    run_id: uuid.UUID,
    body: ResumeRequest,
    org_id: uuid.UUID = Depends(get_current_org),
    svc: ExecutionService = Depends(_get_service),
) -> WorkflowRunResponse:
    return await svc.resume_run(org_id, run_id, body)
