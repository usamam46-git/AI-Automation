import uuid

import jwt
import pytest
from httpx import AsyncClient

from src.core.config import settings
from src.core.dependencies import require_permission
from src.core.redis import get_redis
from src.main import app as main_app

# ---------------------------------------------------------------------------
# Minimal test-only app for auth routes + permission-gated dummy endpoints.
# We mount these endpoints on the full main_app so the db/redis middleware
# is identical to production.
# ---------------------------------------------------------------------------


@main_app.get("/test-read", dependencies=[require_permission("workflow:read")], include_in_schema=False)
async def test_read():
    return {"message": "You can read"}


@main_app.get("/test-write", dependencies=[require_permission("workflow:write")], include_in_schema=False)
async def test_write():
    return {"message": "You can write"}


# --- Helpers ---


def generate_random_email():
    return f"testuser_{uuid.uuid4().hex[:8]}@example.com"


# --- Tests ---


@pytest.mark.asyncio
async def test_registration_and_login(client: AsyncClient):
    email = generate_random_email()
    password = "SuperSecretPassword123!"

    # 1. Register
    reg_res = await client.post(
        "/api/v1/auth/register", json={"email": email, "password": password, "full_name": "Test User", "organization_name": "Test Co"}
    )
    assert reg_res.status_code == 201

    # 2. Login
    login_res = await client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert login_res.status_code == 200
    data = login_res.json()
    assert "access_token" in data
    assert login_res.cookies.get("refresh_token") is not None


@pytest.mark.asyncio
async def test_tampered_token_rejection(client: AsyncClient):
    dummy_payload = {"user_id": str(uuid.uuid4()), "org_id": str(uuid.uuid4()), "jti": "fake"}
    tampered_token = jwt.encode(dummy_payload, "wrong_secret", algorithm="HS256")

    res = await client.get("/test-read", headers={"Authorization": f"Bearer {tampered_token}"})
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_role_permissions(client: AsyncClient):
    email = generate_random_email()
    reg_res = await client.post(
        "/api/v1/auth/register", json={"email": email, "password": "password123", "full_name": "Role Test User", "organization_name": "Role Co"}
    )
    assert reg_res.status_code == 201
    token = reg_res.json()["access_token"]

    headers = {"Authorization": f"Bearer {token}"}
    read_res = await client.get("/test-read", headers=headers)
    assert read_res.status_code == 200

    write_res = await client.get("/test-write", headers=headers)
    assert write_res.status_code == 200


@pytest.mark.asyncio
async def test_refresh_token_rotation(client: AsyncClient):
    email = generate_random_email()
    reg_res = await client.post("/api/v1/auth/register", json={"email": email, "password": "password123", "full_name": "A", "organization_name": "B"})
    assert reg_res.status_code == 201
    refresh_token = reg_res.cookies.get("refresh_token")

    # Refresh
    client.cookies.set("refresh_token", refresh_token)
    ref_res = await client.post("/api/v1/auth/refresh")
    assert ref_res.status_code == 200

    new_refresh_token = ref_res.cookies.get("refresh_token")
    assert refresh_token != new_refresh_token

    # Replay protection: old token should now be rejected
    client.cookies.set("refresh_token", refresh_token)
    replay_res = await client.post("/api/v1/auth/refresh")
    assert replay_res.status_code == 401


@pytest.mark.asyncio
async def test_logout_blocklist(client: AsyncClient):
    email = generate_random_email()
    reg_res = await client.post("/api/v1/auth/register", json={"email": email, "password": "password123", "full_name": "A", "organization_name": "B"})
    token = reg_res.json()["access_token"]

    headers = {"Authorization": f"Bearer {token}"}
    assert (await client.get("/test-read", headers=headers)).status_code == 200

    logout_res = await client.post("/api/v1/auth/logout", headers=headers)
    assert logout_res.status_code == 204

    read_res_after = await client.get("/test-read", headers=headers)
    assert read_res_after.status_code == 401


@pytest.mark.asyncio
async def test_switch_org(client: AsyncClient):
    email = generate_random_email()
    reg_res = await client.post("/api/v1/auth/register", json={"email": email, "password": "password123", "full_name": "A", "organization_name": "B"})
    token = reg_res.json()["access_token"]

    payload = jwt.decode(token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
    original_org_id = payload["org_id"]

    switch_res = await client.post(f"/api/v1/auth/switch-org/{original_org_id}", headers={"Authorization": f"Bearer {token}"})
    assert switch_res.status_code == 200
    new_payload = jwt.decode(switch_res.json()["access_token"], settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
    assert new_payload["org_id"] == original_org_id


@pytest.mark.asyncio
async def test_permission_cache(client: AsyncClient):
    email = generate_random_email()
    reg_res = await client.post("/api/v1/auth/register", json={"email": email, "password": "password123", "full_name": "A", "organization_name": "B"})
    token = reg_res.json()["access_token"]
    payload = jwt.decode(token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
    org_id = payload["org_id"]
    user_id = payload["sub"]

    headers = {"Authorization": f"Bearer {token}"}

    # Prime the cache
    await client.get("/test-read", headers=headers)

    # Manually restrict permissions in Redis
    redis = await get_redis()
    cache_key = f"permissions:{org_id}:{user_id}"
    await redis.set(cache_key, '["workflow:read"]')

    write_res = await client.get("/test-write", headers=headers)
    assert write_res.status_code == 403
