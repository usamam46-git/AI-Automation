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
    """
    The five trigger types in Vol. 2 §3.2's schema. Only three are wired to
    anything as of 2026-08-09:

      manual   — POST /workflows/{id}/run (since the executions module landed)
      schedule — cron, dispatched by the beat tick (workers/trigger_tasks.py)
      webhook  — POST /api/v1/triggers/workflows/{id}, HMAC-signed
      email    — NOT IMPLEMENTED. Needs the Gmail/Microsoft OAuth integration
                 flow described in Vol. 2 §646, which is a separate OAuth grant
                 from SSO login and has no code behind it yet.
      event    — NOT IMPLEMENTED. No internal event-bus → trigger binding exists.

    The enum keeps all five so the DB vocabulary and this type stay in sync, but
    WorkflowService rejects the unimplemented two at create/update with a 422
    rather than accepting a workflow that can never fire. See
    IMPLEMENTED_TRIGGER_TYPES in service.py.
    """

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
    next_run_at: datetime | None = None
    last_triggered_at: datetime | None = None
    has_webhook_secret: bool = False
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class WebhookSecretResponse(BaseModel):
    """
    Returned by POST /workflows/{id}/webhook-secret — the ONLY response anywhere
    that carries the plaintext signing secret, and it carries it exactly once.
    The value is not recoverable afterwards: `webhook_secret_encrypted` is
    decryptable server-side (HMAC needs it) but no read endpoint exposes it, so
    a lost secret must be rotated, not looked up. Same one-shot-reveal contract
    every webhook product uses, and the reason `has_webhook_secret` on
    WorkflowResponse is a bool rather than a masked value.
    """

    workflow_id: uuid.UUID
    secret: str = Field(..., description="Plaintext signing secret — shown once, never again.")
    endpoint_path: str = Field(..., description="Path to POST signed payloads to.")
    signature_header: str = Field("X-AAP-Signature", description="Header carrying 'sha256=<hex hmac>'.")
    timestamp_header: str = Field("X-AAP-Timestamp", description="Header carrying the unix-seconds signing time.")


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
