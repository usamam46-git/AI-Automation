"""
modules/organizations/schemas.py — org membership + invitation payloads.

Vol. 3 §10: "Members | Invite/remove, role assignment table, pending-invite
status." Until 2026-08-18 the tables, the five system roles and the
`member:invite`/`member:remove` permission strings all existed and **nothing
wrote an org_memberships row except `AuthService.register`** — so every user in
the product was the sole Owner of their own organization, and Editor, Approver
and Viewer had never been held by a real user outside the test suite.
"""

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field

#: Every system role, most powerful first.
#:
#: This is the order a "who can do what" table should read in, and it is not
#: alphabetical — sorting by name puts Approver above Editor and implies a
#: hierarchy that does not exist.
ROLE_DISPLAY_ORDER = ("Owner", "Admin", "Editor", "Approver", "Viewer")

#: Roles an Owner/Admin may assign through the API.
#:
#: `Owner` is absent deliberately. Ownership transfer is a different operation
#: with different consequences (billing, `org:delete`, the last-Owner rule in
#: `MemberService`) and giving it the same shape as "make this person an Editor"
#: is how an org accidentally acquires a second Owner. It stays a
#: not-yet-built operation rather than a side effect of the role dropdown.
ASSIGNABLE_ROLES = ("Admin", "Editor", "Approver", "Viewer")

MEMBERSHIP_STATUSES = ("invited", "active", "suspended")


class MemberResponse(BaseModel):
    """One row of the roster."""

    id: uuid.UUID
    user_id: uuid.UUID | None = None
    email: str
    full_name: str | None = None
    role_id: uuid.UUID
    role_name: str
    status: str
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class CurrentMemberResponse(BaseModel):
    """
    Who the caller is in this org, and what they may do.

    Exists so the frontend can disable controls the API would refuse anyway.
    Deliberately an endpoint rather than a JWT claim: access tokens live 15
    minutes, so a demoted user would keep their old role in the UI until the
    token rotated. The API would still refuse them — but a button that looks
    live and then 403s is a worse experience than one that is already disabled.
    """

    membership_id: uuid.UUID
    user_id: uuid.UUID
    email: str
    role_name: str
    #: The raw `roles.permissions` column — wildcards and all.
    permissions: list[str]
    #: The same grant with `*` / `*:read` resolved against the real vocabulary.
    #: The client gates on THIS and never reimplements the wildcard rules; see
    #: `core.permissions.expand_permissions`.
    effective_permissions: list[str]
    status: str


class InviteCreate(BaseModel):
    email: EmailStr
    role_name: str = Field(..., description=f"One of {ASSIGNABLE_ROLES}")

    model_config = ConfigDict(extra="forbid")


class InviteResponse(BaseModel):
    """
    A created invitation, **including the accept URL**.

    The URL is returned in the response body because this platform has no email
    delivery — `worker_notifications` boots with an empty task registry. The
    honest answer is to hand the link to the inviter and let them send it
    however they already talk to the person, rather than to pretend a mail was
    sent. When notifications become real this field stays useful for "copy
    link" and the mail becomes an addition, not a replacement.
    """

    member: MemberResponse
    accept_url: str
    expires_in_days: int


class RoleUpdate(BaseModel):
    role_name: str

    model_config = ConfigDict(extra="forbid")


class StatusUpdate(BaseModel):
    status: str = Field(..., description="active | suspended")

    model_config = ConfigDict(extra="forbid")


class RoleOption(BaseModel):
    """
    A role the UI can offer, with the permissions it carries.

    `permissions` is the stored column and `effective_permissions` is what the
    role actually grants — for Owner those are `["*"]` and all 25 respectively.
    A person choosing a role needs the second one; the first is kept because it
    is the truth on disk and a custom-role editor would edit it.
    """

    id: uuid.UUID
    name: str
    permissions: list[str]
    effective_permissions: list[str]
    #: False for Owner. The endpoint returns every system role because the
    #: roles-and-permissions reference table has to show the one that can do
    #: everything — omitting it answers "who can do X" wrongly. This flag is
    #: what keeps that from leaking into an assignment dropdown: filter on it,
    #: never on the list being short.
    assignable: bool


class InvitePreview(BaseModel):
    """
    What an unauthenticated visitor is told about an invitation link.

    Names the organization and the addressed email and nothing else — the
    inviter's identity, the roster and the org's contents are all out of scope
    for someone who has not yet joined and may never.
    """

    organization_name: str
    email: str
    role_name: str


class AcceptInviteResult(BaseModel):
    organization_id: uuid.UUID
    organization_name: str
    role_name: str
