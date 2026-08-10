"""
tests/test_analytics.py — the home dashboard's stat cards (Vol. 3 §5.1).

GET /api/v1/analytics/dashboard is a read-only aggregate over `workflow_runs`.
These tests seed runs directly rather than executing graphs: the figures depend
on `status`, `created_at` and `total_cost_usd`, and driving a real run through
the engine to land a row in `failed` (or dated 40 days ago) is both slower and
less precise than inserting one.

The window arithmetic is what actually earns tests here — the counters
themselves are a COUNT. Specifically:
  - `cost_mtd_usd` covers the current UTC month, so last month's spend is out;
  - `success_rate` covers a trailing 30 days, so an ancient failure is out;
  - `rejected`/`cancelled` are excluded from the success-rate denominator,
    which is the decision most likely to be "helpfully" reverted later.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from httpx import AsyncClient
from sqlalchemy import select

from src.db.database import async_session_maker
from src.modules.executions.models import WorkflowRun
from src.modules.workflows.models import Workflow

DASHBOARD_URL = "/api/v1/analytics/dashboard"


async def _org_setup(client: AsyncClient, tag: str) -> dict[str, Any]:
    """A registered org with one published workflow version to hang runs off."""
    from test_executions import _register_and_publish

    ctx = await _register_and_publish(client, f"analytics-{tag}")

    async with async_session_maker() as session:
        workflow = (await session.execute(select(Workflow).where(Workflow.id == uuid.UUID(ctx["workflow_id"])))).scalar_one()
        ctx["org_id"] = workflow.organization_id

    return ctx


async def _seed_run(
    ctx: dict[str, Any],
    *,
    status: str,
    cost: float | None = None,
    age: timedelta = timedelta(0),
) -> None:
    """
    Insert one run at a controlled status/age/cost.

    `created_at` is `server_default=func.now()`, so it must be set explicitly to
    place a row outside a window — assigning the attribute overrides the default.
    """
    async with async_session_maker() as session:
        session.add(
            WorkflowRun(
                organization_id=ctx["org_id"],
                workflow_version_id=uuid.UUID(ctx["version_id"]),
                status=status,
                total_cost_usd=cost,
                created_at=datetime.now(UTC) - age,
            )
        )
        await session.commit()


async def _stats(client: AsyncClient, ctx: dict[str, Any]) -> dict[str, Any]:
    resp = await client.get(DASHBOARD_URL, headers=ctx["headers"])
    assert resp.status_code == 200, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# 1. Empty state
# ---------------------------------------------------------------------------


async def test_org_with_no_runs_reports_zeros_and_a_null_success_rate(client: AsyncClient):
    """
    A brand-new org must not render as "0% success". Zero finished runs means
    the rate is undefined, and the API says so with null rather than 0.0.
    """
    ctx = await _org_setup(client, "empty")

    body = await _stats(client, ctx)

    assert body["active_runs"] == 0
    assert body["needs_approval"] == 0
    assert body["cost_mtd_usd"] == 0
    assert body["success_rate"] is None
    assert body["success_rate_sample_size"] == 0


# ---------------------------------------------------------------------------
# 2. The four cards
# ---------------------------------------------------------------------------


async def test_active_runs_counts_pending_and_running_but_not_waiting_approval(client: AsyncClient):
    """
    Vol. 3 §5.1 gives waiting_approval its own card. Counting it in both would
    make the two cards overlap and overstate work in flight.
    """
    ctx = await _org_setup(client, "active")
    await _seed_run(ctx, status="pending")
    await _seed_run(ctx, status="running")
    await _seed_run(ctx, status="running")
    await _seed_run(ctx, status="waiting_approval")
    await _seed_run(ctx, status="completed")

    body = await _stats(client, ctx)

    assert body["active_runs"] == 3
    assert body["needs_approval"] == 1


async def test_in_flight_cards_are_not_windowed(client: AsyncClient):
    """
    A run blocked on an approval for months is the exact thing the card exists
    to surface — it must not age out of the count the way cost and success rate do.
    """
    ctx = await _org_setup(client, "stale")
    await _seed_run(ctx, status="waiting_approval", age=timedelta(days=200))
    await _seed_run(ctx, status="pending", age=timedelta(days=200))

    body = await _stats(client, ctx)

    assert body["needs_approval"] == 1
    assert body["active_runs"] == 1


async def test_cost_mtd_sums_this_month_only(client: AsyncClient):
    """
    The figure is month-to-date, so a run from before the 1st is excluded. Dated
    45 days back so the assertion holds regardless of which day the suite runs.
    """
    ctx = await _org_setup(client, "cost")
    await _seed_run(ctx, status="completed", cost=1.5)
    await _seed_run(ctx, status="failed", cost=0.25)
    await _seed_run(ctx, status="completed", cost=99.0, age=timedelta(days=45))

    body = await _stats(client, ctx)

    assert body["cost_mtd_usd"] == 1.75
    assert body["cost_period_start"].startswith(datetime.now(UTC).strftime("%Y-%m-01"))


async def test_null_costs_do_not_break_the_sum(client: AsyncClient):
    """
    `total_cost_usd` is nullable and condition/tool-only runs leave it NULL.
    SUM ignores nulls; the COALESCE covers the all-null case.
    """
    ctx = await _org_setup(client, "nullcost")
    await _seed_run(ctx, status="completed", cost=None)
    await _seed_run(ctx, status="completed", cost=None)

    body = await _stats(client, ctx)

    assert body["cost_mtd_usd"] == 0


# ---------------------------------------------------------------------------
# 3. Success rate — the denominator decision
# ---------------------------------------------------------------------------


async def test_success_rate_is_completed_over_completed_plus_failed(client: AsyncClient):
    ctx = await _org_setup(client, "rate")
    for _ in range(3):
        await _seed_run(ctx, status="completed")
    await _seed_run(ctx, status="failed")

    body = await _stats(client, ctx)

    assert body["success_rate"] == 0.75
    assert body["success_rate_sample_size"] == 4


async def test_rejected_and_cancelled_runs_are_excluded_from_the_success_rate(client: AsyncClient):
    """
    **This is a deliberate product decision, not an oversight.**

    A rejected run is the Vol. 4 §4.3 approval gate working correctly. Counting
    it as a failure would mean an org's success rate falls the more carefully it
    reviews mutating actions, which inverts the incentive the gate exists to
    create. `cancelled` is likewise a human decision.

    If this test is failing because someone widened the denominator, the change
    is wrong unless the product decision was revisited first.
    """
    ctx = await _org_setup(client, "rejected")
    await _seed_run(ctx, status="completed")
    await _seed_run(ctx, status="rejected")
    await _seed_run(ctx, status="cancelled")

    body = await _stats(client, ctx)

    assert body["success_rate"] == 1.0
    assert body["success_rate_sample_size"] == 1


async def test_success_rate_ignores_runs_older_than_the_window(client: AsyncClient):
    """
    The rate must move when reliability moves. A failure from 40 days ago is
    outside the 30-day window and must not drag a currently-healthy org down.
    """
    ctx = await _org_setup(client, "window")
    await _seed_run(ctx, status="completed")
    await _seed_run(ctx, status="failed", age=timedelta(days=40))

    body = await _stats(client, ctx)

    assert body["success_rate"] == 1.0
    assert body["success_rate_sample_size"] == 1
    assert body["success_rate_window_days"] == 30


# ---------------------------------------------------------------------------
# 4. Tenant isolation
# ---------------------------------------------------------------------------


async def test_dashboard_counts_only_the_callers_org(client: AsyncClient):
    """
    The mandatory cross-tenant test for a new scoped endpoint. This one can't
    assert a 404 — there is no resource id in the path — so it asserts the
    stronger property instead: Org B's runs are invisible in Org A's figures.
    """
    org_a = await _org_setup(client, "iso-a")
    org_b = await _org_setup(client, "iso-b")

    await _seed_run(org_a, status="completed", cost=2.0)
    for _ in range(5):
        await _seed_run(org_b, status="running", cost=50.0)
    await _seed_run(org_b, status="waiting_approval")

    body_a = await _stats(client, org_a)

    assert body_a["active_runs"] == 0
    assert body_a["needs_approval"] == 0
    assert body_a["cost_mtd_usd"] == 2.0

    body_b = await _stats(client, org_b)

    assert body_b["active_runs"] == 5
    assert body_b["needs_approval"] == 1
    assert body_b["cost_mtd_usd"] == 250.0


# ---------------------------------------------------------------------------
# 5. The module is read-only
# ---------------------------------------------------------------------------


async def test_dashboard_requires_authentication(client: AsyncClient):
    resp = await client.get(DASHBOARD_URL)
    assert resp.status_code == 401


async def test_no_mutating_route_on_the_dashboard(client: AsyncClient):
    """
    analytics owns no tables and exposes exactly one verb. Mirrors
    test_no_mutating_route_on_audit_logs — adding a writer here fails the suite.
    """
    ctx = await _org_setup(client, "readonly")

    for method in ("post", "patch", "put", "delete"):
        resp = await getattr(client, method)(DASHBOARD_URL, headers=ctx["headers"])
        assert resp.status_code == 405, f"{method.upper()} {DASHBOARD_URL} returned {resp.status_code}"
