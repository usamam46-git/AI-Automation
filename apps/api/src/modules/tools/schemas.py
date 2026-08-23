"""
modules/tools/schemas.py — request/response contracts for the tool registry.

Vol. 2 §9.2 documents no `/api/v1/tools` endpoints at all, so this contract is
derived rather than transcribed. What it does follow verbatim: §9.1's REST
conventions (tenant scope from the token and never from the request), §3.3's
column set, and §7.2's "the tool registry IS the function-calling contract".

`name` is constrained to OpenAI's function-name grammar for that last reason —
a registry row whose name the API would reject is a row that can never be
handed to a model.

**`secrets` is write-only and `secret_keys` is its only echo** (2026-08-23).
`config` is returned verbatim by every read endpoint, so a credential placed
there is a credential handed to anyone holding `tool:read`. Secrets go in their
own AES-256-GCM column and are referenced from config as `{{secrets.<name>}}`;
this mirrors `IntegrationStatusResponse` exposing only `last_four`, and the same
rule applies — there is no code path that decrypts and returns a value over HTTP,
not even to the owning org.
"""

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

# OpenAI's function-name grammar. Enforced here (and by uq_tools_workspace_name
# in the DB) so a tool cannot be registered under a name that would be rejected
# the moment it were sent as a function spec.
TOOL_NAME_PATTERN = r"^[a-zA-Z0-9_-]{1,64}$"


class ToolCreate(BaseModel):
    """
    Deliberately has no `organization_id` — it comes from the authenticated
    context. A client-settable one is a bug (root CLAUDE.md).
    """

    workspace_id: uuid.UUID = Field(..., description="Owning workspace; must belong to the caller's org.")
    name: str = Field(..., pattern=TOOL_NAME_PATTERN, description="Function name exposed to the LLM. Unique within the workspace.")
    tool_type: str = Field(..., description="http_request | erp_connector | knowledge_search. Immutable after create.")
    description: str | None = Field(None, description="What the tool does, in the model's words (Vol. 4 §4.2).")
    input_schema: dict[str, Any] | None = Field(None, description="JSON Schema sent to the LLM as the function's parameters.")
    config: dict[str, Any] | None = Field(None, description="Type-specific settings: url/method/headers for http_request, action for erp_connector.")
    secrets: dict[str, str] | None = Field(
        None,
        description="Credentials referenced from config as {{secrets.<name>}}. Encrypted at rest; never returned by any endpoint.",
    )
    is_mutating: bool = Field(False, description="True if the tool writes external state. Forces an upstream approval node at publish.")


class ToolUpdate(BaseModel):
    """
    `tool_type` and `workspace_id` are absent on purpose, not overlooked:
    changing the type orphans the type-specific config, and changing the
    workspace moves the row's tenancy anchor. Both are rejected as unknown
    fields (see `model_config`) rather than silently ignored.
    """

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(None, pattern=TOOL_NAME_PATTERN)
    description: str | None = None
    input_schema: dict[str, Any] | None = None
    config: dict[str, Any] | None = None
    secrets: dict[str, str] | None = Field(
        None,
        description="Replaces the whole stored secret map when present. Omit to leave it untouched; pass {} to clear it.",
    )
    is_mutating: bool | None = None


class ToolResponse(BaseModel):
    id: uuid.UUID
    organization_id: uuid.UUID
    workspace_id: uuid.UUID
    name: str
    description: str | None = None
    tool_type: str
    input_schema: dict[str, Any] | None = None
    config: dict[str, Any] | None = None
    secret_keys: list[str] = Field(
        default_factory=list,
        description="Names of the stored secrets — never their values. There is no endpoint that returns a secret back.",
    )
    is_mutating: bool
    is_active: bool
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
