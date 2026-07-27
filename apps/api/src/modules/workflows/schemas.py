"""
modules/workflows/schemas.py — Pydantic request/response models for the
Workflow shell (metadata only; no graph/version fields per scope boundary).
"""

import uuid
from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class TriggerType(str, Enum):
    manual = "manual"
    schedule = "schedule"
    webhook = "webhook"
    email = "email"
    event = "event"


class WorkflowStatus(str, Enum):
    draft = "draft"
    published = "published"
    archived = "archived"


class WorkflowCreate(BaseModel):
    name: str = Field(..., description="Display name of the workflow")
    description: str | None = Field(None)
    workspace_id: uuid.UUID = Field(..., description="Owning workspace (must belong to caller's org)")
    trigger_type: TriggerType = Field(TriggerType.manual)
    trigger_config: dict[str, Any] | None = Field(None, description="Trigger-type-specific config dict")


class WorkflowUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    trigger_type: TriggerType | None = None
    trigger_config: dict[str, Any] | None = None
    status: WorkflowStatus | None = None


class WorkflowResponse(BaseModel):
    id: uuid.UUID
    organization_id: uuid.UUID
    workspace_id: uuid.UUID
    name: str
    description: str | None = None
    status: str
    trigger_type: str
    trigger_config: dict[str, Any] | None = None
    # Always null at this stage — populated when graph compiler (§6.1) exists
    current_version_id: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
