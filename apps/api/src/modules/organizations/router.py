"""
modules/organizations/router.py — the org roster and invitation flow.

  GET    /api/v1/organizations/members            list the roster
  GET    /api/v1/organizations/members/me         the caller's own role
  GET    /api/v1/organizations/roles              assignable roles
  POST   /api/v1/organizations/members            invite an address
  PATCH  /api/v1/organizations/members/{id}/role  reassign
  PATCH  /api/v1/organizations/members/{id}/status suspend / reactivate
  DELETE /api/v1/organizations/members/{id}       remove or revoke

  GET    /api/v1/organizations/invitations/{token}         preview (public)
  POST   /api/v1/organizations/invitations/{token}/accept  accept (authenticated)

Routers hold no business logic — every rule (last-Owner, no-self-edit,
addressee matching) lives in `MemberService`.

`/members/me` is declared BEFORE `/members/{membership_id}` would be, and there
is deliberately no `GET /members/{id}`: "me" would otherwise be parsed as a
membership UUID and 422.
"""

from __future__ import annotations

import uuid

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.dependencies import get_audit_context, get_current_org, get_current_user, require_permission
from src.core.redis import get_redis
from src.db.database import get_db_session
from src.modules.audit_logs.schemas import AuditContext
from src.modules.auth.models import User
from src.modules.organizations.schemas import (
    AcceptInviteResult,
    CurrentMemberResponse,
    InviteCreate,
    InvitePreview,
    InviteResponse,
    MemberResponse,
    RoleOption,
    RoleUpdate,
    StatusUpdate,
)
from src.modules.organizations.service import MemberService

router = APIRouter(tags=["organizations"])


def _get_service(
    db: AsyncSession = Depends(get_db_session),
    redis: aioredis.Redis = Depends(get_redis),
) -> MemberService:
    return MemberService(db, redis)


def _frontend_base_url(request: Request) -> str:
    """
    Where the accept link should point.

    Prefers the configured frontend origin and falls back to the request's
    Origin header — never to `request.base_url`, which is the API's own host and
    would produce a link to a route the API does not serve.
    """
    from src.core.config import settings

    return settings.FRONTEND_URL or request.headers.get("origin") or "http://localhost:3000"


@router.get(
    "/members",
    response_model=list[MemberResponse],
    dependencies=[require_permission("member:read")],
    summary="List members and pending invitations",
)
async def list_members(
    org_id: uuid.UUID = Depends(get_current_org),
    svc: MemberService = Depends(_get_service),
) -> list[MemberResponse]:
    return await svc.list_members(org_id)


@router.get(
    "/members/me",
    response_model=CurrentMemberResponse,
    summary="The caller's own membership, role and permissions",
)
async def get_my_membership(
    org_id: uuid.UUID = Depends(get_current_org),
    user: User = Depends(get_current_user),
    svc: MemberService = Depends(_get_service),
) -> CurrentMemberResponse:
    # No permission gate: this returns only what the caller already is. Gating
    # it on member:read would leave the UI unable to discover that it should
    # hide the very controls the caller lacks permission for.
    return await svc.get_current_member(org_id, user)


@router.get(
    "/roles",
    response_model=list[RoleOption],
    dependencies=[require_permission("member:read")],
    summary="System roles with the permissions each grants",
)
async def list_roles(
    org_id: uuid.UUID = Depends(get_current_org),
    svc: MemberService = Depends(_get_service),
) -> list[RoleOption]:
    return await svc.list_roles(org_id)


@router.post(
    "/members",
    response_model=InviteResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[require_permission("member:invite")],
    summary="Invite an address to join this organization",
)
async def invite_member(
    body: InviteCreate,
    request: Request,
    org_id: uuid.UUID = Depends(get_current_org),
    context: AuditContext = Depends(get_audit_context),
    svc: MemberService = Depends(_get_service),
) -> InviteResponse:
    return await svc.invite(
        org_id,
        email=str(body.email),
        role_name=body.role_name,
        context=context,
        base_url=_frontend_base_url(request),
    )


@router.patch(
    "/members/{membership_id}/role",
    response_model=MemberResponse,
    dependencies=[require_permission("member:invite")],
    summary="Change a member's role",
)
async def change_member_role(
    membership_id: uuid.UUID,
    body: RoleUpdate,
    org_id: uuid.UUID = Depends(get_current_org),
    user: User = Depends(get_current_user),
    context: AuditContext = Depends(get_audit_context),
    svc: MemberService = Depends(_get_service),
) -> MemberResponse:
    return await svc.change_role(org_id, membership_id, role_name=body.role_name, actor=user, context=context)


@router.patch(
    "/members/{membership_id}/status",
    response_model=MemberResponse,
    dependencies=[require_permission("member:remove")],
    summary="Suspend or reactivate a member",
)
async def change_member_status(
    membership_id: uuid.UUID,
    body: StatusUpdate,
    org_id: uuid.UUID = Depends(get_current_org),
    user: User = Depends(get_current_user),
    context: AuditContext = Depends(get_audit_context),
    svc: MemberService = Depends(_get_service),
) -> MemberResponse:
    # Gated on member:remove, not member:invite: suspending is revoking access,
    # which is the same authority as removing, not the same as adding.
    return await svc.change_status(org_id, membership_id, new_status=body.status, actor=user, context=context)


@router.delete(
    "/members/{membership_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[require_permission("member:remove")],
    summary="Remove a member, or revoke a pending invitation",
)
async def remove_member(
    membership_id: uuid.UUID,
    org_id: uuid.UUID = Depends(get_current_org),
    user: User = Depends(get_current_user),
    context: AuditContext = Depends(get_audit_context),
    svc: MemberService = Depends(_get_service),
) -> Response:
    await svc.remove(org_id, membership_id, actor=user, context=context)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get(
    "/invitations/{token}",
    response_model=InvitePreview,
    summary="What an invitation link is for (unauthenticated)",
)
async def preview_invitation(token: str, svc: MemberService = Depends(_get_service)) -> InvitePreview:
    # Unauthenticated by necessity: the invitee has no account yet, and the
    # accept page must be able to say which organization is inviting them
    # before asking them to register. It reveals only the org name, the
    # addressed email and the role — and every failure mode returns one
    # identical 400, so it cannot be used to probe for membership UUIDs.
    return await svc.preview_invitation(token)


@router.post(
    "/invitations/{token}/accept",
    response_model=AcceptInviteResult,
    summary="Accept an invitation as the signed-in user",
)
async def accept_invitation(
    token: str,
    user: User = Depends(get_current_user),
    context: AuditContext = Depends(get_audit_context),
    svc: MemberService = Depends(_get_service),
) -> AcceptInviteResult:
    # Authenticated, but deliberately NOT org-scoped: the caller's token is for
    # whichever org they are currently in, which is by definition not the one
    # they are joining. The target org comes from the signed token.
    return await svc.accept_invitation(token, user, context)
