"""
modules/notifications/schemas.py — request/response contracts for notifications.

Vol. 2 §9.2 documents no notification endpoints, so this contract is derived
from §9.1's conventions (tenant scope from the token, cursor pagination on raw
ISO `created_at`) rather than transcribed.

There is deliberately **no create schema**. A notification is written by a
workflow's `notify` tool node, never by a client — an endpoint that let a caller
POST arbitrary notifications into their own org would be a spam surface with no
workflow behind it and nothing in the audit trail explaining where the message
came from.
"""

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

#: Channels with a transport. Mirrors `_NOTIFY_CHANNELS` in graphs/node_handlers.py.
IMPLEMENTED_CHANNELS = frozenset({"in_app", "webhook"})


class NotificationResponse(BaseModel):
    id: uuid.UUID
    organization_id: uuid.UUID
    user_id: uuid.UUID | None = None
    channel: str
    payload: dict[str, Any]
    status: str
    read_at: datetime | None = None
    delivered_at: datetime | None = None
    error: str | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class NotificationMarkRead(BaseModel):
    """
    `read_at` is set server-side from `now()`, never from the client — a
    client-supplied timestamp is unverifiable and this column is the only
    evidence that a person saw an alert.
    """

    model_config = ConfigDict(extra="forbid")

    read: bool = Field(True, description="False re-opens a notification the user dismissed by mistake.")
