"""
core/redis.py — Async Redis client lifecycle management.

Provides a single, shared Redis connection pool for the entire application.
All modules that need Redis should import `get_redis` (for FastAPI Depends())
or `redis_client` (for use outside of a request context, e.g. Celery tasks).

Usage inside a FastAPI route / dependency:
    from src.core.redis import get_redis
    import redis.asyncio as aioredis

    async def my_route(r: aioredis.Redis = Depends(get_redis)):
        await r.set("key", "value", ex=60)

Usage outside a request context (startup events, workers):
    from src.core.redis import redis_client
    await redis_client.ping()

Connection pool notes:
  - A single `ConnectionPool` is created at startup and shared across all
    coroutines — this is correct for asyncio; do NOT create a new pool per
    request.
  - `max_connections=20` is a conservative default; tune based on observed
    concurrency.  Each FastAPI worker (uvicorn async loop) shares this pool.
  - `decode_responses=True` means all keys/values come back as `str`, not
    `bytes`.  This is the standard choice for Python code that works with
    string keys and JSON values.  Change to False only if you need raw bytes
    (e.g., for binary blobs — unlikely here).
"""

from __future__ import annotations

import logging

import redis.asyncio as aioredis
from redis.asyncio import ConnectionPool
from redis.exceptions import RedisError

from src.core.config import settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Connection pool (module-level singleton)
# ---------------------------------------------------------------------------

_pool: ConnectionPool | None = None


def _build_pool() -> ConnectionPool:
    """Build the async Redis connection pool from settings."""
    return aioredis.ConnectionPool.from_url(
        settings.REDIS_URL,
        max_connections=20,
        decode_responses=True,  # keys & values are str, not bytes
        socket_connect_timeout=5,
        socket_timeout=5,
        retry_on_timeout=True,
    )


# The shared client — thin wrapper around the pool, safe to import anywhere.
# It is *not* connected until the first command is issued.
redis_client: aioredis.Redis


# ---------------------------------------------------------------------------
# FastAPI lifespan helpers
# ---------------------------------------------------------------------------

async def init_redis() -> None:
    """
    Called once at application startup (from main.py lifespan context).

    Creates the connection pool and verifies connectivity with a PING.
    Raises on failure so the app refuses to start with a broken Redis config.
    """
    global _pool, redis_client

    _pool = _build_pool()
    redis_client = aioredis.Redis(connection_pool=_pool)

    try:
        pong = await redis_client.ping()
        logger.info("Redis connected — PING response: %s | url: %s", pong, _redacted_url())
    except RedisError as exc:
        logger.critical("Redis connection failed at startup: %s", exc)
        raise


async def close_redis() -> None:
    """
    Called once at application shutdown (from main.py lifespan context).

    Gracefully closes all pooled connections.
    """
    global _pool, redis_client
    if _pool is not None:
        await _pool.aclose()
        logger.info("Redis connection pool closed.")
        _pool = None


# ---------------------------------------------------------------------------
# FastAPI dependency
# ---------------------------------------------------------------------------

async def get_redis() -> aioredis.Redis:
    """
    FastAPI dependency that yields the shared Redis client.

    Example:
        @router.get("/example")
        async def example(r: aioredis.Redis = Depends(get_redis)):
            value = await r.get("some-key")
    """
    return redis_client


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _redacted_url() -> str:
    """Return the Redis URL with the password masked for safe logging."""
    url = settings.REDIS_URL
    if "@" in url:
        # redis://:password@host:port/db  →  redis://:***@host:port/db
        parts = url.split("@")
        credentials_part = parts[0]
        if ":" in credentials_part.split("//")[-1]:
            scheme_and_user, _ = credentials_part.rsplit(":", 1)
            url = f"{scheme_and_user}:***@{'@'.join(parts[1:])}"
    return url
