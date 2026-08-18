"""
modules/organizations/repository.py — queries over org_memberships and roles.

Every method here is scoped by `organization_id`. `org_memberships` carries the
column directly, so scoping is a WHERE clause rather than a join — but the
scoping is not optional: a membership id is a bare UUID and looking one up
without its org is how one tenant edits another's roster.
"""

import uuid
from collections.abc import Sequence

from sqlalchemy import Row, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.modules.auth.models import OrgMembership, Role, User


class MemberRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    def _roster_stmt(self):
        # LEFT OUTER on users: an invitation created for an address that has no
        # account yet has `user_id = NULL`, and that row must still appear on
        # the roster as a pending invite. An inner join would hide exactly the
        # rows the "pending-invite status" column exists to show.
        return select(OrgMembership, User, Role).outerjoin(User, User.id == OrgMembership.user_id).join(Role, Role.id == OrgMembership.role_id)

    async def list_members(self, organization_id: uuid.UUID) -> Sequence[Row[tuple[OrgMembership, User | None, Role]]]:
        stmt = (
            self._roster_stmt()
            .where(OrgMembership.organization_id == organization_id)
            # Pending invitations first — they are the rows that need an action.
            .order_by(OrgMembership.status != "invited", OrgMembership.created_at.asc())
        )
        return (await self.db.execute(stmt)).all()

    async def get_membership(self, organization_id: uuid.UUID, membership_id: uuid.UUID) -> Row[tuple[OrgMembership, User | None, Role]] | None:
        stmt = self._roster_stmt().where(
            OrgMembership.organization_id == organization_id,
            OrgMembership.id == membership_id,
        )
        return (await self.db.execute(stmt)).one_or_none()

    async def get_membership_by_id_unscoped(self, membership_id: uuid.UUID) -> OrgMembership | None:
        """
        The one deliberate exception to org scoping, for the invitation-accept
        path alone — the invitee has no session in the target org yet, so there
        is no authenticated `organization_id` to scope by. The org is read off
        the membership row and off the signed token, never off the request.
        """
        return (await self.db.execute(select(OrgMembership).where(OrgMembership.id == membership_id))).scalar_one_or_none()

    async def get_for_user(self, organization_id: uuid.UUID, user_id: uuid.UUID) -> Row[tuple[OrgMembership, User | None, Role]] | None:
        stmt = self._roster_stmt().where(
            OrgMembership.organization_id == organization_id,
            OrgMembership.user_id == user_id,
        )
        return (await self.db.execute(stmt)).one_or_none()

    async def find_by_email(self, organization_id: uuid.UUID, email: str) -> OrgMembership | None:
        """
        Existing membership for an address, whether or not it has an account.

        Two shapes have to be caught: a user who already joined (matched through
        `users.email`), and an invitation to an address with no account yet
        (matched through `org_memberships.invited_email`). Missing either lets a
        second invitation be minted for someone already on the roster.
        """
        stmt = (
            select(OrgMembership)
            .outerjoin(User, User.id == OrgMembership.user_id)
            .where(
                OrgMembership.organization_id == organization_id,
                (func.lower(User.email) == email.lower()) | (func.lower(OrgMembership.invited_email) == email.lower()),
            )
        )
        return (await self.db.execute(stmt)).scalars().first()

    async def get_user_by_email(self, email: str) -> User | None:
        # users.email is citext, so this comparison is already case-insensitive
        # at the database; lower() is belt and braces for a non-citext replica.
        return (await self.db.execute(select(User).where(func.lower(User.email) == email.lower()))).scalar_one_or_none()

    async def get_role_by_name(self, name: str, organization_id: uuid.UUID | None = None) -> Role | None:
        """
        System roles have `organization_id IS NULL` and are shared by every org.
        A future custom role would be org-owned; the query prefers an org's own
        role of that name and falls back to the system one.
        """
        stmt = select(Role).where(Role.name == name).order_by(Role.organization_id.is_(None))
        if organization_id is not None:
            stmt = stmt.where((Role.organization_id == organization_id) | (Role.organization_id.is_(None)))
        else:
            stmt = stmt.where(Role.organization_id.is_(None))
        return (await self.db.execute(stmt)).scalars().first()

    async def list_roles(self, names: Sequence[str], organization_id: uuid.UUID) -> Sequence[Role]:
        stmt = (
            select(Role).where(Role.name.in_(names), (Role.organization_id == organization_id) | (Role.organization_id.is_(None))).order_by(Role.name)
        )
        return (await self.db.execute(stmt)).scalars().all()

    async def count_active_owners(self, organization_id: uuid.UUID) -> int:
        """
        How many active Owners the org has.

        The guard behind the last-Owner rule. Counts `status = 'active'` only:
        a suspended or merely invited Owner cannot administer anything, so
        leaving one of those as the sole Owner strands the organization just as
        surely as removing the last one.
        """
        stmt = (
            select(func.count())
            .select_from(OrgMembership)
            .join(Role, Role.id == OrgMembership.role_id)
            .where(
                OrgMembership.organization_id == organization_id,
                OrgMembership.status == "active",
                Role.name == "Owner",
            )
        )
        return (await self.db.execute(stmt)).scalar_one()

    async def create_membership(
        self,
        *,
        organization_id: uuid.UUID,
        user_id: uuid.UUID | None,
        role_id: uuid.UUID,
        invited_email: str,
        status: str,
    ) -> OrgMembership:
        row = OrgMembership(
            organization_id=organization_id,
            user_id=user_id,
            role_id=role_id,
            invited_email=invited_email,
            status=status,
        )
        self.db.add(row)
        await self.db.flush()
        return row

    async def delete_membership(self, membership: OrgMembership) -> None:
        await self.db.delete(membership)
        await self.db.flush()
