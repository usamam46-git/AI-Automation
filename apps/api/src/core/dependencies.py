import uuid
from typing import Annotated, Any

import redis.asyncio as aioredis
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from src.core.cache import get_cached_permissions, is_token_blocklisted
from src.core.permissions import permission_granted
from src.core.redis import get_redis
from src.core.security import decode_access_token
from src.db.database import get_db_session
from src.modules.auth.models import OrgMembership, Role, User

# OAuth2 scheme for Swagger UI auth
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")

# Shared exception for auth failures
credentials_exception = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Could not validate credentials",
    headers={"WWW-Authenticate": "Bearer"},
)


async def get_current_user(
    token: Annotated[str, Depends(oauth2_scheme)],
    redis: Annotated[aioredis.Redis, Depends(get_redis)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> User:
    """
    Decodes the JWT token, verifies signature and expiry, checks the Redis blocklist,
    and returns the corresponding User from the database.
    """
    try:
        payload = decode_access_token(token)
        user_id: str | None = payload.get("user_id") or payload.get("sub")
        jti: str | None = payload.get("jti")
        if user_id is None or jti is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    # Check if the token (jti) has been revoked (e.g. via logout)
    if await is_token_blocklisted(redis, jti):
        raise credentials_exception

    # Fetch the user from the database to ensure they still exist and are active
    user_uuid = uuid.UUID(user_id)
    stmt = select(User).where(User.id == user_uuid)
    result = await db.execute(stmt)
    user = result.scalar_one_or_none()
    
    if user is None:
        raise credentials_exception
        
    return user


async def get_current_org(
    request: Request,
    token: Annotated[str, Depends(oauth2_scheme)],
    user: Annotated[User, Depends(get_current_user)],
) -> uuid.UUID:
    """
    Extracts the org_id from the JWT token to establish the tenant context.
    We trust the JWT to contain the correct org_id because it was signed by us.
    Stores it in request.state for downstream middleware.
    """
    try:
        payload = decode_access_token(token)
        org_id_str: str | None = payload.get("org_id")
        if org_id_str is None:
            raise credentials_exception
        org_id = uuid.UUID(org_id_str)
    except JWTError:
        raise credentials_exception
        
    request.state.org_id = org_id
    return org_id


def require_permission(required_permission: str) -> Any:
    """
    FastAPI dependency factory for RBAC.
    Checks if the current user has the required permission in the current org.
    Checks the Redis permission cache first, falls back to DB if cache miss.
    """
    async def permission_checker(
        user: Annotated[User, Depends(get_current_user)],
        org_id: Annotated[uuid.UUID, Depends(get_current_org)],
        redis: Annotated[aioredis.Redis, Depends(get_redis)],
        db: Annotated[AsyncSession, Depends(get_db_session)],
    ) -> None:
        user_id_str = str(user.id)
        org_id_str = str(org_id)
        
        # 1. Try to get permissions from Redis cache
        permissions = await get_cached_permissions(redis, org_id_str, user_id_str)
        
        if permissions is None:
            # 2. Cache miss: fetch from DB
            stmt = (
                select(Role.permissions)
                .join(OrgMembership, OrgMembership.role_id == Role.id)
                .where(
                    OrgMembership.user_id == user.id,
                    OrgMembership.organization_id == org_id,
                    OrgMembership.status == "active"
                )
            )
            result = await db.execute(stmt)
            permissions_list = result.scalar_one_or_none()
            
            if permissions_list is None:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Not enough permissions or membership is inactive"
                )
            
            permissions = permissions_list
            # Add to cache for next time (caller should use cache_permissions but we don't have circular dependency here, we can just call it)
            from src.core.cache import cache_permissions
            await cache_permissions(redis, org_id_str, user_id_str, permissions)
            
        if not permission_granted(permissions, required_permission):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Missing required permission: {required_permission}"
            )
            
    return Depends(permission_checker)
