import uuid

import redis.asyncio as aioredis
from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from src.core.cache import (
    blocklist_token,
    invalidate_permissions_cache,
)
from src.core.config import settings
from src.core.security import (
    create_access_token,
    create_refresh_token,
    decode_access_token,
    get_password_hash,
    hash_refresh_token,
    verify_password,
)
from src.modules.auth.models import OrgMembership, Role, User
from src.modules.auth.schemas import LoginRequest, RegisterRequest, TokenResponse
from src.modules.organizations.models import Organization
from src.modules.workspaces.models import Workspace


class AuthService:
    def __init__(self, db: AsyncSession, redis: aioredis.Redis):
        self.db = db
        self.redis = redis

    async def register(self, req: RegisterRequest) -> TokenResponse:
        """
        Creates a User, Organization, Workspace, and OrgMembership (Owner role).
        Returns a token pair scoped to the new org.
        """
        # Check if user already exists
        existing = await self.db.execute(select(User).where(User.email == req.email))
        if existing.scalar_one_or_none():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Email already registered",
            )

        # Get system Owner role (use first() in case dev DB has harmless duplicates)
        owner_role = await self.db.execute(select(Role).where(Role.is_system == True, Role.name == "Owner"))  # noqa: E712
        owner_role_obj = owner_role.scalars().first()
        if not owner_role_obj:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="System roles not seeded",
            )

        # 1. Create User
        user = User(
            email=req.email,
            hashed_password=get_password_hash(req.password),
            full_name=req.full_name,
        )
        self.db.add(user)
        await self.db.flush()

        # 2. Create Organization
        # Slugify the org name trivially for now (production would use a proper slugifier)
        slug = req.organization_name.lower().replace(" ", "-") + "-" + str(uuid.uuid4())[:8]
        org = Organization(name=req.organization_name, slug=slug)
        self.db.add(org)
        await self.db.flush()

        # 3. Create Default Workspace
        workspace = Workspace(organization_id=org.id, name="Default Workspace", is_default=True)
        self.db.add(workspace)

        # 4. Create OrgMembership
        membership = OrgMembership(organization_id=org.id, user_id=user.id, role_id=owner_role_obj.id, status="active")
        self.db.add(membership)
        await self.db.commit()

        # Generate tokens
        return await self._generate_token_response(user.id, org.id)

    async def login(self, req: LoginRequest) -> TokenResponse:
        """
        Verifies credentials and returns a token pair.
        """
        # Fetch user with active memberships
        stmt = select(User).options(selectinload(User.memberships.and_(OrgMembership.status == "active"))).where(User.email == req.email)
        result = await self.db.execute(stmt)
        user = result.scalar_one_or_none()

        if not user or not user.hashed_password:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid email or password",
            )

        if not verify_password(req.password, user.hashed_password):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid email or password",
            )

        if not user.memberships:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="User does not belong to any active organizations",
            )

        # Determine target org
        target_org_id = None
        if req.organization_id:
            try:
                requested_org_uuid = uuid.UUID(req.organization_id)
            except ValueError:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid org ID format")

            for m in user.memberships:
                if m.organization_id == requested_org_uuid:
                    target_org_id = requested_org_uuid
                    break
            if not target_org_id:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Not a member of the requested organization",
                )
        else:
            # Default to the first active membership
            target_org_id = user.memberships[0].organization_id

        return await self._generate_token_response(user.id, target_org_id)

    async def switch_org(self, user_id: uuid.UUID, target_org_id_str: str) -> TokenResponse:
        """
        Issues a new token pair scoped to the target org, assuming the user is a member.
        """
        try:
            target_org_id = uuid.UUID(target_org_id_str)
        except ValueError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid org ID format")

        stmt = select(OrgMembership).where(
            OrgMembership.user_id == user_id, OrgMembership.organization_id == target_org_id, OrgMembership.status == "active"
        )
        membership = (await self.db.execute(stmt)).scalar_one_or_none()

        if not membership:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Not a member of the requested organization",
            )

        return await self._generate_token_response(user_id, target_org_id)

    async def refresh_tokens(self, refresh_token: str) -> TokenResponse:
        """
        Validates refresh token and issues a new pair (Refresh Token Rotation).
        """
        key = self._refresh_token_key(refresh_token)
        val = await self.redis.get(key)

        if not val:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or expired refresh token",
            )

        # Parse user_id and org_id
        try:
            user_id_str, org_id_str = val.split(":")
            user_id = uuid.UUID(user_id_str)
            org_id = uuid.UUID(org_id_str)
        except Exception:
            # Delete corrupted token
            await self.redis.delete(key)
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token data")

        # Rotate: delete old token
        await self.redis.delete(key)

        # Issue new token pair
        return await self._generate_token_response(user_id, org_id)

    async def logout(self, access_token: str, refresh_token: str | None = None) -> None:
        """
        Revokes the access token (adds to blocklist) and deletes the refresh token.
        """
        if refresh_token:
            await self.redis.delete(self._refresh_token_key(refresh_token))

        try:
            payload = decode_access_token(access_token)
            jti = payload.get("jti")
            exp = payload.get("exp")
            if jti and exp:
                import time

                now = int(time.time())
                ttl = exp - now
                if ttl > 0:
                    await blocklist_token(self.redis, jti, ttl)
        except Exception:
            # If the token is already expired or invalid, we don't need to blocklist it
            pass

    async def _generate_token_response(self, user_id: uuid.UUID, org_id: uuid.UUID) -> TokenResponse:
        """Helper to generate and store token pair."""
        access_token = create_access_token(str(user_id), str(org_id))
        refresh_token = create_refresh_token()

        ttl_seconds = settings.JWT_REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60 * 60
        key = self._refresh_token_key(refresh_token)
        val = f"{user_id}:{org_id}"
        await self.redis.set(key, val, ex=ttl_seconds)

        # We temporarily put refresh_token in access_token field or a custom dict
        # to pass it to the router, which will extract it and put it in a cookie.
        # But TokenResponse schema doesn't have refresh_token.
        # Let's return a dict and let the router construct the response.
        return {"access_token": access_token, "token_type": "bearer", "refresh_token": refresh_token}  # type: ignore

    @staticmethod
    def _refresh_token_key(refresh_token: str) -> str:
        return f"refresh_token:{hash_refresh_token(refresh_token)}"

    async def update_user_role(self, user_id: uuid.UUID, org_id: uuid.UUID, new_role_id: uuid.UUID) -> None:
        """
        TODO: Hook this into the Members module when built.
        Updates user role and invalidates the permission cache.
        """
        # ... db update logic ...
        await invalidate_permissions_cache(self.redis, str(org_id), str(user_id))
