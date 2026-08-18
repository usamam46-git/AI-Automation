"""
modules/organizations/service.py — org roster, invitations and role assignment.

Vol. 3 §10. Every rule that protects an organization from being locked out of
itself lives here, not in the router.

## The rules, and why each exists

- **The last active Owner cannot be demoted, suspended or removed.** An org with
  no active Owner has nobody holding `"*"`, which means nobody can assign roles,
  manage billing or delete it — and no endpoint anywhere can repair that, because
  every repair path is itself Owner-gated. It is unrecoverable without database
  access, so it is a 409 rather than a warning.
- **Nobody may change their own role or status.** Self-elevation is the obvious
  half; the useful half is that an Admin cannot demote themselves into a state
  they then cannot undo. Owners are covered by the rule above as well.
- **`Owner` is not assignable through the role dropdown.** Ownership transfer
  has different consequences from "make this person an Editor" and deserves its
  own reviewed operation. Not built; deliberately absent rather than sneaked in.
- **An invitation is addressed to a person, not to whoever holds the link.**
  `accept_invitation` compares the token's `email` claim against the
  authenticated user's address. Without that, a forwarded link is a bearer
  credential granting membership of someone else's organization.
"""

import uuid

from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.cache import invalidate_permissions_cache
from src.core.config import settings
from src.core.permissions import expand_permissions
from src.core.security import create_invite_token, decode_invite_token
from src.modules.audit_logs.schemas import AuditContext
from src.modules.audit_logs.service import AuditAction, AuditService
from src.modules.auth.models import OrgMembership, Role, User
from src.modules.organizations.models import Organization
from src.modules.organizations.repository import MemberRepository
from src.modules.organizations.schemas import (
    ASSIGNABLE_ROLES,
    ROLE_DISPLAY_ORDER,
    AcceptInviteResult,
    CurrentMemberResponse,
    InvitePreview,
    InviteResponse,
    MemberResponse,
    RoleOption,
)


def _conflict(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


class MemberService:
    def __init__(self, db: AsyncSession, redis=None) -> None:
        self.db = db
        self.redis = redis
        self._repo = MemberRepository(db)
        self._audit = AuditService(db)

    # -- reads --------------------------------------------------------------

    @staticmethod
    def _to_response(membership: OrgMembership, user: User | None, role: Role) -> MemberResponse:
        return MemberResponse(
            id=membership.id,
            user_id=membership.user_id,
            # A pending invitation has no user row, so the address it was sent
            # to is the only identity it has.
            email=(user.email if user else membership.invited_email) or "",
            full_name=user.full_name if user else None,
            role_id=role.id,
            role_name=role.name,
            status=membership.status,
            created_at=membership.created_at,
        )

    async def list_members(self, organization_id: uuid.UUID) -> list[MemberResponse]:
        rows = await self._repo.list_members(organization_id)
        return [self._to_response(m, u, r) for m, u, r in rows]

    async def list_roles(self, organization_id: uuid.UUID) -> list[RoleOption]:
        """
        Every system role, ordered by power rather than by name.

        Includes Owner, which `ASSIGNABLE_ROLES` excludes — the reference table
        must show it, and `assignable` is how the client tells the two uses
        apart. Sorting is done here rather than in SQL because the order is a
        presentation decision (`ROLE_DISPLAY_ORDER`), not a property of the rows.
        """
        roles = await self._repo.list_roles(ROLE_DISPLAY_ORDER, organization_id)
        ordered = sorted(roles, key=lambda r: ROLE_DISPLAY_ORDER.index(r.name) if r.name in ROLE_DISPLAY_ORDER else len(ROLE_DISPLAY_ORDER))
        return [
            RoleOption(
                id=r.id,
                name=r.name,
                permissions=list(r.permissions or []),
                effective_permissions=expand_permissions(list(r.permissions or [])),
                assignable=r.name in ASSIGNABLE_ROLES,
            )
            for r in ordered
        ]

    async def get_current_member(self, organization_id: uuid.UUID, user: User) -> CurrentMemberResponse:
        row = await self._repo.get_for_user(organization_id, user.id)
        if row is None:
            # Reachable only if the membership was removed after the caller's
            # token was minted — the token is still validly signed for 15
            # minutes. 403 rather than 404: the org exists, they are not in it.
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No membership in this organization")
        membership, _user, role = row
        return CurrentMemberResponse(
            membership_id=membership.id,
            user_id=user.id,
            email=user.email,
            role_name=role.name,
            permissions=list(role.permissions or []),
            effective_permissions=expand_permissions(list(role.permissions or [])),
            status=membership.status,
        )

    # -- invitations --------------------------------------------------------

    async def invite(
        self,
        organization_id: uuid.UUID,
        *,
        email: str,
        role_name: str,
        context: AuditContext,
        base_url: str,
    ) -> InviteResponse:
        if role_name not in ASSIGNABLE_ROLES:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"role_name must be one of {list(ASSIGNABLE_ROLES)}",
            )

        role = await self._repo.get_role_by_name(role_name, organization_id)
        if role is None:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"Unknown role '{role_name}'")

        existing = await self._repo.find_by_email(organization_id, email)
        if existing is not None:
            raise _conflict(
                "That address already has a pending invitation to this organization"
                if existing.status == "invited"
                else "That address is already a member of this organization"
            )

        # An existing account is linked immediately; the membership still starts
        # as `invited`, so it grants nothing until accepted. Consent is the
        # point — being added to an organization is not something someone else
        # gets to decide for you.
        user = await self._repo.get_user_by_email(email)

        try:
            membership = await self._repo.create_membership(
                organization_id=organization_id,
                user_id=user.id if user else None,
                role_id=role.id,
                invited_email=email,
                status="invited",
            )
        except IntegrityError:
            await self.db.rollback()
            raise _conflict("That address already has a pending invitation to this organization")

        token = create_invite_token(membership_id=str(membership.id), org_id=str(organization_id), email=email)

        await self._audit.record(
            organization_id=organization_id,
            context=context,
            action=AuditAction.MEMBER_INVITED,
            resource_type="org_membership",
            resource_id=membership.id,
            # The address and the role are the material facts. The token is NOT
            # recorded: it is a live credential for joining the org, and the
            # audit trail is readable by every Admin.
            metadata={"email": email, "role": role.name, "existing_account": user is not None},
        )
        await self.db.commit()
        await self.db.refresh(membership)

        return InviteResponse(
            member=self._to_response(membership, user, role),
            accept_url=f"{base_url.rstrip('/')}/accept-invite?token={token}",
            expires_in_days=settings.INVITE_TOKEN_EXPIRE_DAYS,
        )

    async def preview_invitation(self, token: str) -> InvitePreview:
        membership, role, org = await self._resolve_invitation(token)
        return InvitePreview(organization_name=org.name, email=membership.invited_email or "", role_name=role.name)

    async def accept_invitation(self, token: str, user: User, context: AuditContext) -> AcceptInviteResult:
        membership, role, org = await self._resolve_invitation(token)

        invited_email = (membership.invited_email or "").lower()
        if invited_email and invited_email != user.email.lower():
            # The link was forwarded, or someone is signed in as the wrong
            # account. Either way this is not their invitation.
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"This invitation was sent to {membership.invited_email}. Sign in as that user to accept it.",
            )

        membership.user_id = user.id
        membership.status = "active"
        await self.db.flush()

        await self._audit.record(
            organization_id=membership.organization_id,
            context=context,
            action=AuditAction.MEMBER_INVITATION_ACCEPTED,
            resource_type="org_membership",
            resource_id=membership.id,
            metadata={"email": user.email, "role": role.name},
        )
        await self.db.commit()

        return AcceptInviteResult(organization_id=org.id, organization_name=org.name, role_name=role.name)

    async def _resolve_invitation(self, token: str) -> tuple[OrgMembership, Role, Organization]:
        """
        Decode a token and load the membership it names, or 400.

        Every failure returns the SAME message. A bad signature, an expired
        token, a membership that was revoked and one that was already accepted
        must be indistinguishable — otherwise the endpoint reports which
        membership UUIDs exist to an unauthenticated caller. Same reasoning as
        the webhook trigger's uniform 401.
        """
        invalid = HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="This invitation link is invalid or has expired")
        try:
            payload = decode_invite_token(token)
            membership_id = uuid.UUID(payload["mid"])
        except Exception:
            raise invalid

        membership = await self._repo.get_membership_by_id_unscoped(membership_id)
        if membership is None or membership.status != "invited":
            raise invalid
        if str(membership.organization_id) != payload.get("org_id"):
            raise invalid

        role = await self.db.get(Role, membership.role_id)
        org = await self.db.get(Organization, membership.organization_id)
        if role is None or org is None:
            raise invalid
        return membership, role, org

    # -- mutations ----------------------------------------------------------

    async def _load(self, organization_id: uuid.UUID, membership_id: uuid.UUID) -> tuple[OrgMembership, User | None, Role]:
        row = await self._repo.get_membership(organization_id, membership_id)
        if row is None:
            # 404, never 403 — a membership in another org must be
            # indistinguishable from one that does not exist.
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Member not found")
        return row

    async def _guard_not_self(self, membership: OrgMembership, actor: User, verb: str) -> None:
        if membership.user_id is not None and membership.user_id == actor.id:
            raise _conflict(f"You cannot {verb} yourself")

    async def _guard_last_owner(self, membership: OrgMembership, role: Role, action: str) -> None:
        if role.name != "Owner" or membership.status != "active":
            return
        if await self._repo.count_active_owners(membership.organization_id) <= 1:
            raise _conflict(
                f"Cannot {action} the last active Owner — the organization would have nobody able to "
                "manage members, billing or roles, and no endpoint could repair it."
            )

    async def change_role(
        self, organization_id: uuid.UUID, membership_id: uuid.UUID, *, role_name: str, actor: User, context: AuditContext
    ) -> MemberResponse:
        if role_name not in ASSIGNABLE_ROLES:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"role_name must be one of {list(ASSIGNABLE_ROLES)}",
            )

        membership, user, current_role = await self._load(organization_id, membership_id)
        await self._guard_not_self(membership, actor, "change the role of")
        await self._guard_last_owner(membership, current_role, "demote")

        new_role = await self._repo.get_role_by_name(role_name, organization_id)
        if new_role is None:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"Unknown role '{role_name}'")

        previous = current_role.name
        membership.role_id = new_role.id
        await self.db.flush()

        await self._audit.record(
            organization_id=organization_id,
            context=context,
            action=AuditAction.MEMBER_ROLE_CHANGED,
            resource_type="org_membership",
            resource_id=membership.id,
            metadata={"email": (user.email if user else membership.invited_email), "from": previous, "to": new_role.name},
        )
        await self.db.commit()
        await self._invalidate(organization_id, membership.user_id)
        return self._to_response(membership, user, new_role)

    async def change_status(
        self, organization_id: uuid.UUID, membership_id: uuid.UUID, *, new_status: str, actor: User, context: AuditContext
    ) -> MemberResponse:
        if new_status not in ("active", "suspended"):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="status must be 'active' or 'suspended'")

        membership, user, role = await self._load(organization_id, membership_id)
        await self._guard_not_self(membership, actor, "suspend or reactivate")

        if membership.status == "invited":
            raise _conflict("That invitation has not been accepted yet — revoke it instead of suspending it")
        if new_status == "suspended":
            await self._guard_last_owner(membership, role, "suspend")

        previous = membership.status
        membership.status = new_status
        await self.db.flush()

        await self._audit.record(
            organization_id=organization_id,
            context=context,
            action=AuditAction.MEMBER_STATUS_CHANGED,
            resource_type="org_membership",
            resource_id=membership.id,
            metadata={"email": (user.email if user else membership.invited_email), "from": previous, "to": new_status},
        )
        await self.db.commit()
        # Suspension must take effect NOW, not when a cached permission set
        # expires. The cache is keyed by (org, user) and is what
        # `require_permission` reads before touching the database.
        await self._invalidate(organization_id, membership.user_id)
        return self._to_response(membership, user, role)

    async def remove(self, organization_id: uuid.UUID, membership_id: uuid.UUID, *, actor: User, context: AuditContext) -> None:
        membership, user, role = await self._load(organization_id, membership_id)
        await self._guard_not_self(membership, actor, "remove")
        await self._guard_last_owner(membership, role, "remove")

        email = user.email if user else membership.invited_email
        removed_user_id = membership.user_id

        await self._audit.record(
            organization_id=organization_id,
            context=context,
            action=AuditAction.MEMBER_REMOVED,
            resource_type="org_membership",
            resource_id=membership.id,
            # Recorded BEFORE the delete: the audit row outlives the membership,
            # which is the entire point of recording a removal.
            metadata={"email": email, "role": role.name, "was_status": membership.status},
        )
        await self._repo.delete_membership(membership)
        await self.db.commit()
        await self._invalidate(organization_id, removed_user_id)

    async def _invalidate(self, organization_id: uuid.UUID, user_id: uuid.UUID | None) -> None:
        if self.redis is None or user_id is None:
            return
        await invalidate_permissions_cache(self.redis, str(organization_id), str(user_id))
