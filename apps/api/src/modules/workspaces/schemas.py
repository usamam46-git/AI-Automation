import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class WorkspaceCreate(BaseModel):
    name: str = Field(..., description="Name of the workspace")
    icon: Optional[str] = Field(None, description="Emoji or icon identifier")


class WorkspaceUpdate(BaseModel):
    name: Optional[str] = Field(None, description="Name of the workspace")
    icon: Optional[str] = Field(None, description="Emoji or icon identifier")


class WorkspaceResponse(BaseModel):
    id: uuid.UUID
    organization_id: uuid.UUID
    name: str
    icon: Optional[str] = None
    is_default: bool
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
