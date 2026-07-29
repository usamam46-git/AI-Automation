"""
modules/workflows/schemas.py — Pydantic request/response models for the
Workflow shell and versioned graph definitions (nodes/edges).
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
    current_version_id: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class NodeType(str, Enum):
    agent = "agent"
    tool = "tool"
    condition = "condition"
    human_approval = "human_approval"
    subgraph = "subgraph"
    start = "start"
    end = "end"


class NodeInput(BaseModel):
    node_key: str
    node_type: NodeType
    config: dict[str, Any] = Field(default_factory=dict)
    position_x: float
    position_y: float


class EdgeInput(BaseModel):
    source_node_key: str
    target_node_key: str
    condition: dict[str, Any] | None = None


class WorkflowVersionCreate(BaseModel):
    nodes: list[NodeInput]
    edges: list[EdgeInput]


class NodeResponse(BaseModel):
    id: uuid.UUID
    node_key: str
    node_type: str
    config: dict[str, Any] | None = None
    position_x: float | None = None
    position_y: float | None = None

    model_config = ConfigDict(from_attributes=True)


class EdgeResponse(BaseModel):
    id: uuid.UUID
    source_node_key: str
    target_node_key: str
    condition: dict[str, Any] | None = None

    model_config = ConfigDict(from_attributes=True)


class WorkflowVersionResponse(BaseModel):
    id: uuid.UUID
    workflow_id: uuid.UUID
    version_number: int
    nodes: list[NodeResponse]
    edges: list[EdgeResponse]
    published_by: uuid.UUID | None = None
    published_at: datetime | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class WorkflowVersionSummary(BaseModel):
    id: uuid.UUID
    version_number: int
    published_at: datetime | None = None
    node_count: int
    edge_count: int
