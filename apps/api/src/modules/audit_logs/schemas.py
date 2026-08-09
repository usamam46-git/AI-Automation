"""
modules/audit_logs/schemas.py — Pydantic models + the actor-context object.

Vol. 2 §3.5, §13 §700.

There is deliberately NO create/update schema. Audit rows are never accepted
from a client; services construct them as a side effect of the action they
record, and the database rejects UPDATE/DELETE outright (migration
20260809_audit_log_immutability).
"""

import uuid
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ActorType(str, Enum):
    user = "user"
    agent = "agent"
    system = "system"


@dataclass(frozen=True)
class AuditContext:
    """
    Who is performing an action, and from where.

    Passed explicitly from routers into services rather than read from a
    contextvar. Two reasons the implicit version was rejected: half the
    call sites are Celery tasks with no request at all (the schedule tick, the
    graph worker), where a contextvar would silently carry whatever the last
    HTTP request left behind; and an explicit parameter makes it visible at
    every call site that an action IS audited.

    Build it with `Depends(get_audit_context)` in a router, or
    `AuditContext.system()` in a worker.
    """

    actor_type: ActorType
    actor_id: uuid.UUID | None = None
    ip_address: str | None = None

    @classmethod
    def system(cls) -> "AuditContext":
        """
        A platform-level action with no human behind it — the schedule tick, a
        webhook-triggered run. `actor_id` and `ip_address` are null by
        definition; the caller's IP on a webhook belongs to the *sender*, not to
        an actor in this org, so it is deliberately not recorded as one.
        """
        return cls(actor_type=ActorType.system)

    @classmethod
    def for_user(cls, user_id: uuid.UUID, ip_address: str | None = None) -> "AuditContext":
        return cls(actor_type=ActorType.user, actor_id=user_id, ip_address=ip_address)


class AuditLogResponse(BaseModel):
    id: uuid.UUID
    organization_id: uuid.UUID
    actor_type: str
    actor_id: uuid.UUID | None = None
    action: str
    resource_type: str
    resource_id: uuid.UUID | None = None
    event_metadata: dict[str, Any] | None = Field(
        None,
        # The column is `metadata`; the attribute is renamed because `metadata`
        # is reserved on a SQLAlchemy declarative class. Exposed under the
        # column's real name so the API matches the schema in Vol. 2 §3.5.
        serialization_alias="metadata",
        validation_alias="event_metadata",
    )
    ip_address: str | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    @field_validator("ip_address", mode="before")
    @classmethod
    def _stringify_ip(cls, value: Any) -> str | None:
        """
        The column is Postgres INET, which the driver hands back as an
        ipaddress.IPv4Address/IPv6Address object, not a str — so a bare
        `str | None` annotation fails response validation. Coerced here rather
        than typed as IPvAnyAddress because the column is nullable free-text in
        practice (X-Forwarded-For can carry anything) and a strict IP type would
        turn a junk header into a 500 on a read endpoint.
        """
        return None if value is None else str(value)
