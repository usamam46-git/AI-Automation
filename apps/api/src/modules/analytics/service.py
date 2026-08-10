"""
modules/analytics/service.py — The home dashboard's four stat cards (Vol. 3 §5.1).

Read-only. Nothing here writes a row, so nothing here records an audit event:
`AuditService.record` is for *material actions*, and viewing a dashboard is not
one. Adding a `dashboard.viewed` action would bury the eight actions that
matter under page-view noise.

Note this module has no `models.py`, breaking the "every module has exactly
five files" convention in apps/api/CLAUDE.md. That is deliberate — analytics
owns no tables and defines no entities; it aggregates `workflow_runs`. An empty
models.py would imply a schema that does not exist and would need adding to
`src/db/all_models.py`.
"""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from src.modules.analytics.repository import AnalyticsRepository
from src.modules.analytics.schemas import DashboardStatsResponse

#: Trailing window for the success rate, in days.
#:
#: Vol. 3 §5.1 shows a bare "97.4%" with no window, so this is a contract
#: invented here rather than transcribed. 30 days over all-time because a
#: success rate that averages in an org's first fumbling week forever is
#: useless as an operational signal — the number needs to move when reliability
#: moves. It is returned in the payload so the UI can label the card honestly.
SUCCESS_RATE_WINDOW_DAYS = 30


def _month_start(now: datetime) -> datetime:
    """
    First instant of `now`'s month, in UTC.

    UTC rather than a per-org timezone because there is no per-org timezone to
    read — `organizations` has no such column. (Workflow crons DO carry an IANA
    timezone, but that is per-workflow trigger config and there is no defensible
    way to pick one of them to define the org's billing month.) Worth revisiting
    when the billing module becomes real, since an invoice period and this
    figure should agree.
    """
    return datetime(now.year, now.month, 1, tzinfo=UTC)


class AnalyticsService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self._repo = AnalyticsRepository(db)

    async def get_dashboard_stats(
        self,
        organization_id: uuid.UUID,
        *,
        now: datetime | None = None,
    ) -> DashboardStatsResponse:
        """
        `now` is injectable so the month-boundary and window arithmetic is
        testable without freezing the system clock.
        """
        now = now or datetime.now(UTC)
        cost_period_start = _month_start(now)
        success_window_start = now - timedelta(days=SUCCESS_RATE_WINDOW_DAYS)

        counters = await self._repo.dashboard_counters(
            organization_id,
            cost_period_start=cost_period_start,
            success_window_start=success_window_start,
        )

        # Denominator excludes `rejected` and `cancelled` deliberately. A
        # rejected run is the approval gate doing its job — Vol. 4 §4.3's whole
        # point — and counting it as a failure would mean an org's success rate
        # drops the more carefully it reviews mutating actions. `cancelled` is
        # likewise a human decision, not a malfunction.
        sample_size = counters.completed_in_window + counters.failed_in_window
        success_rate = (counters.completed_in_window / sample_size) if sample_size else None

        return DashboardStatsResponse(
            active_runs=counters.active_runs,
            needs_approval=counters.needs_approval,
            cost_mtd_usd=counters.cost_mtd_usd,
            success_rate=success_rate,
            cost_period_start=cost_period_start,
            success_rate_window_days=SUCCESS_RATE_WINDOW_DAYS,
            success_rate_sample_size=sample_size,
        )
