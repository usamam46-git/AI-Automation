"""
Redis-backed compiled graph cache keyed by workflow_version_id.

CompiledStateGraph objects contain unpicklable closures, so we keep the runnable graph
in a process-local store and use Redis only as a presence/invalidation marker (no TTL for
published versions — content is immutable; drafts are invalidated on save_draft replace).

Uses the shared Redis client from src.core.redis.
"""

from __future__ import annotations

import logging

import redis.asyncio as aioredis
from cachetools import LRUCache
from langgraph.graph.state import CompiledStateGraph

from src.core.config import settings

logger = logging.getLogger(__name__)

COMPILER_CACHE_VERSION = "1"

# Process-local store — each API/Celery worker process holds compiled graphs in memory.
_LOCAL_COMPILED_GRAPHS: LRUCache[str, CompiledStateGraph] = LRUCache(
    maxsize=settings.COMPILED_GRAPH_CACHE_MAXSIZE,
)


def _cache_key(workflow_version_id: str) -> str:
    return f"compiled_graph:{COMPILER_CACHE_VERSION}:{workflow_version_id}"


async def get_cached_graph(r: aioredis.Redis, workflow_version_id: str) -> CompiledStateGraph | None:
    """Return a cached compiled graph when Redis marker and local entry both exist."""
    marker = await r.get(_cache_key(workflow_version_id))
    if marker is None:
        return None
    return _LOCAL_COMPILED_GRAPHS.get(workflow_version_id)


async def cache_graph(r: aioredis.Redis, workflow_version_id: str, compiled_graph: CompiledStateGraph) -> None:
    """Store compiled graph locally and set Redis invalidation marker (no TTL)."""
    _LOCAL_COMPILED_GRAPHS[workflow_version_id] = compiled_graph
    await r.set(_cache_key(workflow_version_id), "1")


async def invalidate_cached_graph(r: aioredis.Redis, workflow_version_id: str) -> None:
    """Evict local compiled graph and Redis marker (called on draft replace)."""
    _LOCAL_COMPILED_GRAPHS.pop(workflow_version_id, None)
    deleted = await r.delete(_cache_key(workflow_version_id))
    logger.debug(
        "Compiled graph cache invalidated: version_id=%s (deleted=%d)",
        workflow_version_id,
        deleted,
    )
