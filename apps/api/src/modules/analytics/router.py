"""
modules/analytics/router.py — Read-only aggregates for the dashboard.

  GET /api/v1/analytics/dashboard — the four Vol. 3 §5.1 stat cards

Gated on `execution:read`, not a new `analytics:read`. Every figure here is an
aggregate of data that permission already exposes per-run — `total_cost_usd` is
on `WorkflowRunResponse` — so a separate grant would add a role-seeding concern
without protecting anything new, and would lock Viewer out of the product's
home page.

This module is read-only by construction, like `audit_logs`: no POST, no PATCH,
no DELETE. It owns no tables to mutate.

The dashboard's other two sections (Recent Executions, Your Workflows) are NOT
served from here. They call the existing `GET /api/v1/executions` and
`GET /api/v1/workflows` with a small `limit` — same rows, already-correct
shapes, and the frontend's React Query cache is shared with the full list pages
so navigating to either is instant.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.dependencies import get_current_org, require_permission
from src.db.database import get_db_session
from src.modules.analytics.schemas import DashboardStatsResponse
from src.modules.analytics.service import AnalyticsService

router = APIRouter(tags=["analytics"])


def _get_service(db: AsyncSession = Depends(get_db_session)) -> AnalyticsService:
    return AnalyticsService(db)


@router.get(
    "/dashboard",
    response_model=DashboardStatsResponse,
    dependencies=[require_permission("execution:read")],
    summary="Home dashboard stat cards for the org",
)
async def get_dashboard_stats(
    org_id: uuid.UUID = Depends(get_current_org),
    svc: AnalyticsService = Depends(_get_service),
) -> DashboardStatsResponse:
    return await svc.get_dashboard_stats(org_id)
