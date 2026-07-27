import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class WorkspaceCreate(BaseModel):
    name: str = Field(..., description="Name of the workspace")
    icon: str | None = Field(None, description="Emoji or icon identifier")


class WorkspaceUpdate(BaseModel):
    name: str | None = Field(None, description="Name of the workspace")
    icon: str | None = Field(None, description="Emoji or icon identifier")


class WorkspaceResponse(BaseModel):
    id: uuid.UUID
    organization_id: uuid.UUID
    name: str
    icon: str | None = None
    is_default: bool
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
