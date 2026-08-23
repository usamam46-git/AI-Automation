"""
modules/notifications/router.py — a user's own notifications.

  GET   /api/v1/notifications              the caller's notifications + org broadcasts
  PATCH /api/v1/notifications/{id}/read    mark read (or unread)

**There is no POST, and that is deliberate.** A notification is written by a
workflow's `notify` tool node. An endpoint that let a client create arbitrary
notifications in their own org would be a spam surface with no workflow behind
it and nothing in the audit trail saying where the message came from.

**Gated on authentication, NOT on a permission**, which is the one place this
codebase deliberately departs from `require_permission`. The endpoint is
self-scoped by construction — the repository's predicate is `organization_id
AND (user_id = me OR user_id IS NULL)` — so there is no privilege to check: a
Viewer must be able to read an alert addressed to them, and no role should be
able to read a colleague's. Introducing `notification:read` would mean seeding
it onto all five roles to grant something the query already limits, which is a
permission that gates nothing while looking like it gates something.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.dependencies import get_current_org, get_current_user
from src.db.database import get_db_session
from src.modules.auth.models import User
from src.modules.notifications.schemas import NotificationMarkRead, NotificationResponse
from src.modules.notifications.service import NotificationService

router = APIRouter(tags=["notifications"])


def _get_service(db: AsyncSession = Depends(get_db_session)) -> NotificationService:
    return NotificationService(db)


@router.get("", response_model=list[NotificationResponse])
async def list_notifications(
    unread_only: bool = Query(False, description="Only notifications the caller has not marked read."),
    cursor: str | None = Query(None, description="Raw ISO created_at of the last row from the previous page."),
    limit: int = Query(50, ge=1, le=100),
    organization_id: uuid.UUID = Depends(get_current_org),
    user: User = Depends(get_current_user),
    service: NotificationService = Depends(_get_service),
) -> list[NotificationResponse]:
    """
    Bare array, cursor-paginated on raw ISO `created_at` — the same convention as
    workflows, executions and the audit log. Passing the cursor through verbatim
    matters: a round-trip via JS `Date` truncates to milliseconds and the
    boundary row would be re-served on every page.
    """
    return list(await service.list_for_user(organization_id, user.id, unread_only=unread_only, cursor=cursor, limit=limit))


@router.patch("/{notification_id}/read", response_model=NotificationResponse)
async def mark_read(
    notification_id: uuid.UUID,
    payload: NotificationMarkRead,
    organization_id: uuid.UUID = Depends(get_current_org),
    user: User = Depends(get_current_user),
    service: NotificationService = Depends(_get_service),
) -> NotificationResponse:
    """404 (never 403) for someone else's notification — the usual isolation rule."""
    return await service.set_read(organization_id, user.id, notification_id, read=payload.read)
