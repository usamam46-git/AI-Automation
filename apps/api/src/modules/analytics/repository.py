"""
modules/analytics/repository.py — Aggregate queries behind the home dashboard.

SELECT only. This module owns no tables; it reads `workflow_runs`.

Tenant scoping is on `workflow_runs.organization_id` directly. That column is
denormalized on purpose (see modules/executions/models.py) precisely so
dashboard queries need no join — same reasoning ExecutionRepository.list_runs
records.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.modules.executions.models import WorkflowRun

#: Run statuses that mean "in flight". `waiting_approval` is deliberately NOT
#: here — Vol. 3 §5.1 gives it its own card, and counting it twice would make
#: the two cards sum to more than the work actually in progress.
ACTIVE_STATUSES = ("pending", "running")


@dataclass(frozen=True)
class DashboardCounters:
    """Raw aggregates. The service turns these into the response's figures."""

    active_runs: int
    needs_approval: int
    cost_mtd_usd: float
    completed_in_window: int
    failed_in_window: int


class AnalyticsRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def dashboard_counters(
        self,
        organization_id: uuid.UUID,
        *,
        cost_period_start: datetime,
        success_window_start: datetime,
    ) -> DashboardCounters:
        """
        Every figure on the dashboard in ONE pass over the org's runs.

        Written as five aggregate expressions with FILTER clauses rather than
        five separate queries. `workflow_runs` is the highest-volume table in
        the schema and this endpoint is hit on every dashboard load, so the
        difference is one index scan versus five. Postgres computes all five
        from the same scan of the `organization_id` index.

        `waiting_approval` and the active statuses are counted all-time; only
        the cost and success-rate figures are windowed. A run that has been
        blocked on an approval since last month is still blocked, and dropping
        it out of the count at a 30-day boundary would quietly hide the exact
        thing the card exists to surface.
        """
        stmt = select(
            func.count().filter(WorkflowRun.status.in_(ACTIVE_STATUSES)).label("active_runs"),
            func.count().filter(WorkflowRun.status == "waiting_approval").label("needs_approval"),
            # COALESCE because SUM over zero rows is NULL, not 0 — a brand-new
            # org would otherwise fail response validation on a non-optional float.
            func.coalesce(
                func.sum(WorkflowRun.total_cost_usd).filter(WorkflowRun.created_at >= cost_period_start),
                0,
            ).label("cost_mtd_usd"),
            func.count().filter(WorkflowRun.status == "completed", WorkflowRun.created_at >= success_window_start).label("completed_in_window"),
            func.count().filter(WorkflowRun.status == "failed", WorkflowRun.created_at >= success_window_start).label("failed_in_window"),
        ).where(WorkflowRun.organization_id == organization_id)

        row = (await self.db.execute(stmt)).one()

        return DashboardCounters(
            active_runs=row.active_runs,
            needs_approval=row.needs_approval,
            # Numeric(12,6) comes back as Decimal; the schema is a float and
            # Decimal does not implicitly satisfy it under strict pydantic.
            cost_mtd_usd=float(row.cost_mtd_usd),
            completed_in_window=row.completed_in_window,
            failed_in_window=row.failed_in_window,
        )
