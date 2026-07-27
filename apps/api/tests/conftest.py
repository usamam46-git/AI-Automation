import asyncio
from typing import AsyncGenerator

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.redis import close_redis, get_redis, init_redis
from src.db.database import async_session_maker
from src.db.seed_roles import seed_system_roles
from src.main import app


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(autouse=True)
async def setup_services():
    """Initialize Redis, flush it for test isolation, and seed system roles."""
    await init_redis()
    redis = await get_redis()
    await redis.flushdb()

    # Seed roles so auth registration works in integration tests
    async with async_session_maker() as session:
        await seed_system_roles(session)

    yield
    await close_redis()


@pytest.fixture
async def client() -> AsyncGenerator[AsyncClient, None]:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac


@pytest.fixture
async def session() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_maker() as session:
        yield session
