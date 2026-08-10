"""
modules/analytics/schemas.py — Response shape for the home dashboard.

Vol. 3 §5.1 specifies four stat cards — Active Runs, Needs Approval, Cost
(MTD), Success Rate — and this is the payload behind them.

There is deliberately NO create/update schema. This module is read-only: it
owns no tables and every figure here is an aggregate over `workflow_runs`.
"""

from datetime import datetime

from pydantic import BaseModel, Field


class DashboardStatsResponse(BaseModel):
    """
    The four §5.1 stat cards, in one round trip.

    The window boundaries are returned alongside the figures rather than being
    left implicit. The UI renders them as the cards' subtitles ("this month",
    "last 30 days"), so a change to either constant here does not need a
    matching edit in the frontend to keep the labels honest.
    """

    active_runs: int = Field(
        ...,
        description="Runs currently pending or running. All-time, not windowed — a run stuck at `pending` for a week is still occupying a slot and should stay visible.",
    )
    needs_approval: int = Field(
        ...,
        description="Runs halted at a human_approval interrupt, waiting on someone. All-time, for the same reason.",
    )
    cost_mtd_usd: float = Field(
        ...,
        description="Sum of workflow_runs.total_cost_usd since the start of the current UTC month.",
    )
    success_rate: float | None = Field(
        ...,
        description=(
            "completed / (completed + failed) over the trailing window, as a "
            "fraction in [0, 1]. NULL when the denominator is zero — an org "
            "with no finished runs has no success rate, and reporting 0.0 "
            "would render as a damning '0%' for a brand-new account."
        ),
    )

    # Context for the figures above.
    cost_period_start: datetime = Field(..., description="Start of the UTC month the cost figure covers.")
    success_rate_window_days: int = Field(..., description="Length of the trailing window the success rate covers.")
    success_rate_sample_size: int = Field(
        ...,
        description="completed + failed in the window — the denominator. Lets the UI de-emphasise a 100% built from two runs.",
    )
