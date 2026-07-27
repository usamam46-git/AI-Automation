"""
modules/workflows/schemas.py — Pydantic request/response models for the
Workflow shell (metadata only; no graph/version fields per scope boundary).
"""

import uuid
from datetime import datetime
from enum import Enum
from typing import Any, Optional

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
    description: Optional[str] = Field(None)
    workspace_id: uuid.UUID = Field(..., description="Owning workspace (must belong to caller's org)")
    trigger_type: TriggerType = Field(TriggerType.manual)
    trigger_config: Optional[dict[str, Any]] = Field(None, description="Trigger-type-specific config dict")


class WorkflowUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    trigger_type: Optional[TriggerType] = None
    trigger_config: Optional[dict[str, Any]] = None
    status: Optional[WorkflowStatus] = None


class WorkflowResponse(BaseModel):
    id: uuid.UUID
    organization_id: uuid.UUID
    workspace_id: uuid.UUID
    name: str
    description: Optional[str] = None
    status: str
    trigger_type: str
    trigger_config: Optional[dict[str, Any]] = None
    # Always null at this stage — populated when graph compiler (§6.1) exists
    current_version_id: Optional[uuid.UUID] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
