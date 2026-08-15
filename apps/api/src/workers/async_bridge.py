"""
workers/async_bridge.py — run an async coroutine from a synchronous Celery task.

Extracted from `graph_tasks.py` on 2026-08-15 when `document_tasks.py` became a
second consumer. It is one of the three worker invariants apps/api/CLAUDE.md
says not to undo, and a second hand-written copy silently drifting from this one
is exactly the failure that section exists to prevent. Behaviour is unchanged
from the original.
"""

from __future__ import annotations

import asyncio
from typing import Any

from src.db.database import engine
from src.db.sync_database import dispose_sync_engine


def run_async(coro: Any) -> Any:
    """
    Run a coroutine in a fresh event loop, disposing the SQLAlchemy engine's
    connection pool before that loop closes.

    This is mandatory, not tidiness. `engine` is a module-level singleton whose
    pool caches asyncpg connections, and every Celery task runs its own
    `asyncio.run()`, which creates and then destroys a NEW event loop. An asyncpg
    connection is bound to the loop that opened it, so a connection left in the
    pool by task N gets checked out by task N+1 against a loop that no longer
    exists, and the first write fails with

        AttributeError: 'NoneType' object has no attribute 'send'

    `pool_pre_ping` does not save us here: the ping itself runs on the dead
    transport. Disposing per task costs one reconnect and buys correctness — the
    pool was never genuinely reused across tasks anyway.

    This went unnoticed for a long time because a worker never ran a second task:
    the Celery app had no `include`, so its task registry was empty and every job
    was discarded as unregistered.

    The sync engine (`src/db/sync_database.py`, used by ToolExecutionLogger) is
    disposed alongside it. It uses NullPool so there are no idle connections to
    release, but an engine must not be carried across a fork either.
    """

    async def _runner() -> Any:
        try:
            return await coro
        finally:
            await engine.dispose()
            dispose_sync_engine()

    return asyncio.run(_runner())
