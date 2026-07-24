"""
core/cache.py — Typed cache utility layer built on top of the Redis client.

This module provides high-level, typed helpers so that no module in the
codebase needs to know the raw Redis key format or manually handle JSON
serialization/deserialization.

Design decisions:
  - All public functions accept a `redis: aioredis.Redis` argument so they are
    easy to unit-test (inject a FakeRedis instance) and work with the FastAPI
    dependency injected client.
  - JSON is used for serialization because all cached values in this project
    are dict/list/str/int — no binary blobs.
  - Key namespacing follows the pattern `{namespace}:{identifier}`, e.g.:
      jwt_blocklist:{jti}
      permissions:{org_id}:{user_id}
      workflow_version:{version_id}
      rate_limit:{scope}:{identifier}
    Centralizing key construction here prevents typo-driven cache key mismatches
    across modules.

Future use cases wired up here (implementations stub-ready):
  §4 JWT blocklist        → jwt_blocklist_*
  §4 Permission cache     → permissions_*
  §4 Workflow def cache   → workflow_version_*
  §11 Rate limiting       → rate_limit_*  (sliding-window helpers)
"""

from __future__ import annotations

import json
import logging
from typing import Any

import redis.asyncio as aioredis

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Key builders — single source of truth for every Redis key pattern
# ---------------------------------------------------------------------------

class CacheKey:
    """Namespace-prefixed key builders.  Always use these, never hard-code keys."""

    # JWT blocklist — stores revoked token JTIs as members of a Redis Set.
    # One set per day is used so old sets expire automatically.
    @staticmethod
    def jwt_blocklist(jti: str) -> str:
        return f"jwt_blocklist:{jti}"

    # Org/user permission cache — stores the serialized permissions list.
    @staticmethod
    def permissions(org_id: str, user_id: str) -> str:
        return f"permissions:{org_id}:{user_id}"

    # Compiled workflow graph cache — keyed by workflow_version_id.
    @staticmethod
    def workflow_version(version_id: str) -> str:
        return f"workflow_version:{version_id}"

    # Rate limiting — sliding-window counter key.
    # `scope` is e.g. "api_key", "org_trigger", "login_ip", "login_account".
    @staticmethod
    def rate_limit(scope: str, identifier: str) -> str:
        return f"rate_limit:{scope}:{identifier}"

    # LLM response cache (optional, dev/test) — hashed by (model, prompt hash).
    @staticmethod
    def llm_response(cache_hash: str) -> str:
        return f"llm_cache:{cache_hash}"


# ---------------------------------------------------------------------------
# Generic get / set / delete helpers
# ---------------------------------------------------------------------------

async def cache_get(r: aioredis.Redis, key: str) -> Any | None:
    """
    Fetch a JSON-encoded value from Redis.

    Returns the deserialized Python object, or None if the key doesn't exist.
    """
    raw = await r.get(key)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError) as exc:
        logger.warning("cache_get: failed to decode value for key=%s: %s", key, exc)
        return None


async def cache_set(
    r: aioredis.Redis,
    key: str,
    value: Any,
    ttl_seconds: int | None = None,
) -> None:
    """
    Store a JSON-serializable value in Redis.

    Args:
        r:           The Redis client.
        key:         The cache key (use CacheKey builders above).
        value:       Any JSON-serializable Python object.
        ttl_seconds: Optional TTL in seconds.  If None, the key never expires
                     (use only for explicitly invalidated caches like workflow
                     version definitions).
    """
    try:
        serialized = json.dumps(value, default=str)
    except (TypeError, ValueError) as exc:
        logger.error("cache_set: failed to serialize value for key=%s: %s", key, exc)
        return

    if ttl_seconds is not None:
        await r.set(key, serialized, ex=ttl_seconds)
    else:
        await r.set(key, serialized)


async def cache_delete(r: aioredis.Redis, key: str) -> int:
    """
    Delete a key from Redis.

    Returns the number of keys actually deleted (0 if the key didn't exist).
    """
    return await r.delete(key)


async def cache_exists(r: aioredis.Redis, key: str) -> bool:
    """Return True if the given key exists in Redis."""
    return bool(await r.exists(key))


# ---------------------------------------------------------------------------
# §4 JWT blocklist helpers
# ---------------------------------------------------------------------------
# A revoked JWT's `jti` (JWT ID claim) is written here on logout/revoke.
# The middleware checks this on every authenticated request.
# TTL is set to the token's remaining lifetime so Redis self-cleans.

async def blocklist_token(r: aioredis.Redis, jti: str, ttl_seconds: int) -> None:
    """
    Add a JWT ID to the blocklist.

    Args:
        jti:         The unique JWT ID claim (`jti`) of the token to revoke.
        ttl_seconds: Remaining lifetime of the token in seconds.  The key
                     auto-expires after this duration so the blocklist stays
                     small — no cleanup job needed.
    """
    key = CacheKey.jwt_blocklist(jti)
    await r.set(key, "1", ex=ttl_seconds)
    logger.debug("JWT blocklisted: jti=%s ttl=%ds", jti, ttl_seconds)


async def is_token_blocklisted(r: aioredis.Redis, jti: str) -> bool:
    """Return True if the given JWT ID has been revoked."""
    return await cache_exists(r, CacheKey.jwt_blocklist(jti))


# ---------------------------------------------------------------------------
# §4 Permission cache helpers
# ---------------------------------------------------------------------------
# Permissions are cached per (org_id, user_id) as a JSON list of permission
# strings, e.g. ["workflow:read", "workflow:write", "billing:read"].
# TTL = 5 minutes as specified in Vol. 2 §4.
# Invalidated explicitly on role change via invalidate_permissions_cache().

PERMISSIONS_TTL = 5 * 60  # 5 minutes in seconds


async def get_cached_permissions(
    r: aioredis.Redis,
    org_id: str,
    user_id: str,
) -> list[str] | None:
    """
    Retrieve cached permissions for a user in an org.

    Returns the list of permission strings, or None if not cached
    (caller should fetch from DB and call cache_permissions()).
    """
    return await cache_get(r, CacheKey.permissions(org_id, user_id))


async def cache_permissions(
    r: aioredis.Redis,
    org_id: str,
    user_id: str,
    permissions: list[str],
) -> None:
    """Store the resolved permission list for a user in an org (TTL = 5 min)."""
    await cache_set(
        r,
        CacheKey.permissions(org_id, user_id),
        permissions,
        ttl_seconds=PERMISSIONS_TTL,
    )


async def invalidate_permissions_cache(
    r: aioredis.Redis,
    org_id: str,
    user_id: str,
) -> None:
    """
    Evict the permission cache entry for a specific user in an org.

    Call this whenever a user's role is changed or their membership is updated.
    """
    deleted = await cache_delete(r, CacheKey.permissions(org_id, user_id))
    logger.debug(
        "Permission cache invalidated: org=%s user=%s (deleted=%d)",
        org_id, user_id, deleted,
    )


# ---------------------------------------------------------------------------
# §4 Workflow definition cache helpers
# ---------------------------------------------------------------------------
# The compiled LangGraph graph spec is cached by workflow_version_id.
# No TTL — explicitly invalidated when a new version is published.

async def get_cached_workflow_version(
    r: aioredis.Redis,
    version_id: str,
) -> dict | None:
    """
    Return the cached compiled graph definition for a workflow version.

    Returns None if not cached; caller should compile and call
    cache_workflow_version() to populate.
    """
    return await cache_get(r, CacheKey.workflow_version(version_id))


async def cache_workflow_version(
    r: aioredis.Redis,
    version_id: str,
    graph_definition: dict,
) -> None:
    """
    Cache the compiled graph definition for a workflow version.

    No TTL — this cache entry lives until the workflow version is superseded
    and invalidate_workflow_version_cache() is called.
    """
    await cache_set(r, CacheKey.workflow_version(version_id), graph_definition)


async def invalidate_workflow_version_cache(
    r: aioredis.Redis,
    version_id: str,
) -> None:
    """
    Evict the graph definition cache for a workflow version.

    Call this when a new version is published (old version cache is now stale).
    """
    deleted = await cache_delete(r, CacheKey.workflow_version(version_id))
    logger.debug(
        "Workflow version cache invalidated: version_id=%s (deleted=%d)",
        version_id, deleted,
    )


# ---------------------------------------------------------------------------
# §11 Rate limiting helpers (sliding-window counter)
# ---------------------------------------------------------------------------
# Uses a simple Redis counter + TTL approach.  For production-grade sliding
# windows, this will be upgraded to a Lua script (atomic increment + expire)
# when the rate-limiting middleware is implemented in §11.

async def increment_rate_counter(
    r: aioredis.Redis,
    scope: str,
    identifier: str,
    window_seconds: int,
) -> int:
    """
    Increment and return the request count for a rate-limit window.

    Uses Redis INCR + EXPIRE (set only on first increment so window doesn't
    reset mid-flight).  Returns the current count after incrementing.

    Args:
        scope:          e.g. "api_key", "org_trigger", "login_ip"
        identifier:     The specific entity being rate-limited (key, org_id, IP)
        window_seconds: The rolling window duration in seconds.
    """
    key = CacheKey.rate_limit(scope, identifier)
    count = await r.incr(key)
    if count == 1:
        # First request in this window — set the expiry.
        await r.expire(key, window_seconds)
    return count


async def get_rate_count(
    r: aioredis.Redis,
    scope: str,
    identifier: str,
) -> int:
    """Return the current request count for a rate-limit window (0 if none)."""
    key = CacheKey.rate_limit(scope, identifier)
    value = await r.get(key)
    return int(value) if value else 0
