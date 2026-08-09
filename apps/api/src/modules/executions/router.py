"""
modules/executions/router.py — HTTP routes for workflow execution.

Endpoints:
  POST /api/v1/workflows/{workflow_id}/run      — trigger a run
  POST /api/v1/triggers/workflows/{workflow_id} — inbound webhook (UNAUTHENTICATED)
  GET  /api/v1/executions                       — list runs (cursor-paginated)
  GET  /api/v1/executions/{run_id}              — poll run status
  POST /api/v1/executions/{run_id}/resume       — approve or reject a waiting run

Strict layering: router calls service only — zero business logic, zero direct DB/ORM.
organization_id comes ONLY from get_current_org (JWT), never from request body —
except on the webhook route, which has no JWT and resolves the org from the
workflow row it authenticates against by HMAC. See that endpoint's docstring.

The webhook ingress lives here rather than in modules/webhooks/ on purpose: its
job is to create a WorkflowRun and it reuses this module's repository and
enqueue path. The `webhooks` module's model is for OUTBOUND delivery
registrations ("AAP pushes events out"), a different concern.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence

from fastapi import APIRouter, Depends, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.dependencies import get_audit_context, get_current_org, require_permission
from src.db.database import get_db_session
from src.modules.audit_logs.schemas import AuditContext
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
    audit: AuditContext = Depends(get_audit_context),
    svc: ExecutionService = Depends(_get_service),
) -> WorkflowRunResponse:
    return await svc.trigger_run(org_id, workflow_id, body, context=audit)


@router.post(
    "/triggers/workflows/{workflow_id}",
    response_model=WorkflowRunResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Trigger a workflow run from a signed inbound webhook (unauthenticated)",
)
async def trigger_from_webhook(
    workflow_id: uuid.UUID,
    request: Request,
    svc: ExecutionService = Depends(_get_service),
) -> WorkflowRunResponse:
    """
    The only route in the application with no `require_permission` and no
    `get_current_org` — by design, and the three consequences are handled in
    ExecutionService.trigger_from_webhook:

    1. **No JWT.** The caller is an external system (an ERP, a form backend).
       Authorization is the `X-AAP-Signature` HMAC over
       `"{X-AAP-Timestamp}.{raw body}"`, keyed by the workflow's signing secret.
    2. **organization_id comes off the workflow row**, never from the request —
       the root CLAUDE.md invariant holds, it just resolves through the
       workflow instead of through the token.
    3. **Uniform 401.** Unknown workflow, wrong trigger type, no secret set, bad
       signature and stale timestamp are indistinguishable in the response, so
       the endpoint cannot be used to enumerate workflow UUIDs.

    Takes the raw `Request` rather than a Pydantic body because the signature is
    over the exact bytes the caller sent; re-serializing parsed JSON would
    change key order and break verification.

    202, not 201: the run is accepted and enqueued, and the caller (a machine
    that will not poll) is being told the work was queued, not completed.
    """
    return await svc.trigger_from_webhook(
        workflow_id,
        raw_body=await request.body(),
        signature_header=request.headers.get("X-AAP-Signature"),
        timestamp_header=request.headers.get("X-AAP-Timestamp"),
    )


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
    audit: AuditContext = Depends(get_audit_context),
    svc: ExecutionService = Depends(_get_service),
) -> WorkflowRunResponse:
    return await svc.resume_run(org_id, run_id, body, context=audit)
