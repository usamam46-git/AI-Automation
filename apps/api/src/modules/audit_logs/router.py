"""
modules/audit_logs/router.py — Read-only HTTP access to the audit trail.

  GET /api/v1/audit-logs — list the org's audit events (cursor-paginated)

**This module intentionally exposes exactly one verb.** Vol. 2 §13 §700 requires
that "no UPDATE/DELETE route exists" for audit_logs — so there is no POST, no
PATCH and no DELETE here, and none may be added. Rows are written by services as
a side effect of the action they record (see modules/audit_logs/service.py), and
the database rejects mutation independently (migration
20260809_audit_log_immutability), so this is defence in depth rather than the
only control.

Gated on `audit:read`, which is Owner/Admin only. It is in
WILDCARD_READ_EXEMPT precisely so Viewer's `"*:read"` does not reach it — these
rows carry actor identity and client IP addresses.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.dependencies import get_current_org, require_permission
from src.db.database import get_db_session
from src.modules.audit_logs.schemas import AuditLogResponse
from src.modules.audit_logs.service import AuditService

router = APIRouter(tags=["audit-logs"])


def _get_service(db: AsyncSession = Depends(get_db_session)) -> AuditService:
    return AuditService(db)


@router.get(
    "",
    response_model=Sequence[AuditLogResponse],
    dependencies=[require_permission("audit:read")],
    summary="List audit events for the org",
)
async def list_audit_logs(
    action: str | None = Query(None, description="Exact action match, e.g. 'workflow.published'"),
    resource_type: str | None = Query(None, description="Filter by entity type, e.g. 'workflow'"),
    resource_id: uuid.UUID | None = Query(None, description="Filter to one entity's history"),
    actor_id: uuid.UUID | None = Query(None, description="Filter to one user's actions"),
    cursor: str | None = Query(None, description="Cursor for pagination (ISO datetime string)"),
    limit: int = Query(50, ge=1, le=100),
    org_id: uuid.UUID = Depends(get_current_org),
    svc: AuditService = Depends(_get_service),
) -> Sequence[AuditLogResponse]:
    return await svc.list_logs(
        org_id,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        actor_id=actor_id,
        cursor=cursor,
        limit=limit,
    )
