from typing import Annotated

import redis.asyncio as aioredis
from fastapi import APIRouter, Cookie, Depends, HTTPException, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.dependencies import get_current_user, oauth2_scheme
from src.core.rate_limit import RateLimiter
from src.core.redis import get_redis
from src.db.database import get_db_session
from src.modules.auth.models import User
from src.modules.auth.schemas import (
    LoginRequest,
    RegisterRequest,
    TokenResponse,
)
from src.modules.auth.service import AuthService

router = APIRouter()


def get_auth_service(
    db: AsyncSession = Depends(get_db_session),
    redis: aioredis.Redis = Depends(get_redis),
) -> AuthService:
    return AuthService(db, redis)


def set_refresh_token_cookie(response: Response, refresh_token: str) -> None:
    response.set_cookie(
        key="refresh_token",
        value=refresh_token,
        httponly=True,
        secure=True,  # Should be True in production (HTTPS only)
        samesite="strict",
        max_age=30 * 24 * 60 * 60,  # 30 days
    )


@router.post(
    "/register",
    response_model=TokenResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(RateLimiter(requests=3, window=60))],
)
async def register(
    request: RegisterRequest,
    response: Response,
    service: AuthService = Depends(get_auth_service),
):
    """Register a new user, create an organization and default workspace."""
    result = await service.register(request)
    set_refresh_token_cookie(response, result["refresh_token"])
    return TokenResponse(
        access_token=result["access_token"], token_type=result["token_type"]
    )


@router.post(
    "/login",
    response_model=TokenResponse,
    dependencies=[Depends(RateLimiter(requests=5, window=60))],
)
async def login(
    request: LoginRequest,
    response: Response,
    service: AuthService = Depends(get_auth_service),
):
    """Authenticate a user and return access/refresh tokens."""
    result = await service.login(request)
    set_refresh_token_cookie(response, result["refresh_token"])
    return TokenResponse(
        access_token=result["access_token"], token_type=result["token_type"]
    )


@router.post("/switch-org/{org_id}", response_model=TokenResponse)
async def switch_org(
    org_id: str,
    response: Response,
    user: User = Depends(get_current_user),
    service: AuthService = Depends(get_auth_service),
):
    """Switch organization context. Issues a new token pair scoped to the new org."""
    result = await service.switch_org(user.id, org_id)
    set_refresh_token_cookie(response, result["refresh_token"])
    return TokenResponse(
        access_token=result["access_token"], token_type=result["token_type"]
    )


@router.post("/refresh", response_model=TokenResponse)
async def refresh_tokens(
    response: Response,
    refresh_token: Annotated[str | None, Cookie()] = None,
    service: AuthService = Depends(get_auth_service),
):
    """Rotate the refresh token and issue a new access token."""
    if not refresh_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Refresh token missing",
        )
        
    result = await service.refresh_tokens(refresh_token)
    set_refresh_token_cookie(response, result["refresh_token"])
    return TokenResponse(
        access_token=result["access_token"], token_type=result["token_type"]
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    response: Response,
    access_token: str = Depends(oauth2_scheme),
    refresh_token: Annotated[str | None, Cookie()] = None,
    service: AuthService = Depends(get_auth_service),
):
    """Revoke access token and clear refresh token cookie."""
    await service.logout(access_token, refresh_token)
    response.delete_cookie(key="refresh_token", httponly=True, secure=True, samesite="strict")
