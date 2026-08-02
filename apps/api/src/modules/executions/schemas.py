"""
modules/executions/schemas.py — Pydantic request/response models for
workflow run triggering, polling, and approval/rejection.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

# ---------------------------------------------------------------------------
# Request schemas
# ---------------------------------------------------------------------------


class RunTriggerRequest(BaseModel):
    """Body for POST /workflows/{workflow_id}/run."""

    trigger_payload: dict[str, Any] | None = Field(
        default=None,
        description="Arbitrary input data passed to the workflow (webhook body, form data, etc.).",
    )


class ResumeRequest(BaseModel):
    """Body for POST /executions/{run_id}/resume."""

    decision: Literal["approved", "rejected"] = Field(
        ...,
        description="Approval decision. 'rejected' terminates the run immediately with status=rejected.",
    )
    comment: str | None = Field(
        default=None,
        description="Optional human-readable comment attached to the decision.",
    )


# ---------------------------------------------------------------------------
# Response schemas
# ---------------------------------------------------------------------------


class NodeExecutionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    node_key: str
    status: str
    input: dict[str, Any] | None
    output: dict[str, Any] | None
    tokens_prompt: int | None
    tokens_completion: int | None
    cost_usd: float | None
    latency_ms: int
    attempt: int
    created_at: datetime


class WorkflowRunResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    workflow_version_id: uuid.UUID
    organization_id: uuid.UUID
    status: str
    trigger_payload: dict[str, Any] | None
    interrupt_payload: dict[str, Any] | None
    current_node_key: str | None
    started_at: datetime | None
    completed_at: datetime | None
    total_cost_usd: float | None
    error: dict[str, Any] | None
    node_executions: list[NodeExecutionResponse]
    created_at: datetime
