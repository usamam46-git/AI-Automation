"""
db/sync_database.py — a synchronous engine, used by exactly one caller.

Why this exists at all, given the rest of the codebase is async:

Vol. 4 §4.3 requires that a mutating tool call be logged to `tool_executions`
*before* it executes — "so a crash mid-call still leaves an audit trail of
intent". The only place that can be honoured is inside `tool_handler`, and
`tool_handler` is a **synchronous** function running inside a LangGraph
superstep: it has no session, no running-loop context it may block on, and no
way to await. (It is sync deliberately — an `async def` node cannot be driven by
`.invoke()`, which `compile_for_test_run` relies on.)

Rejected alternatives, so nobody re-litigates them:

- Writing the row from `_stream_graph` after the superstep yields. Simpler, no
  second engine — but it records the outcome, not the intent, which is the one
  property §4.3 exists to provide.
- `asyncio.run_coroutine_threadsafe(...).result()` from the handler thread onto
  the loop running `astream`. Works only while LangGraph happens to dispatch
  sync nodes to a worker thread; deadlocks if one ever runs on the loop thread,
  and is a silent no-op under `.invoke()`.

No new dependency: `psycopg2-binary` is already a runtime dependency, and
`alembic/env.py` already uses this same URL-rewrite idiom.

The engine is created lazily and pooled with NullPool. NullPool matters: Celery
tasks run under `_run_async`, which disposes the async engine per task because
asyncpg connections are bound to the loop that opened them. A pooled sync
connection would survive across tasks and across the fork boundary, so it is
cheaper to be correct here than fast — this pool serves a handful of INSERT and
UPDATE statements per run, not request traffic.
"""

from __future__ import annotations

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

from src.core.config import settings

_engine: Engine | None = None
_session_maker: sessionmaker[Session] | None = None


def _sync_url() -> str:
    """Rewrite the asyncpg URL to psycopg2 — same idiom as alembic/env.py."""
    return settings.DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://")


def get_sync_session_maker() -> sessionmaker[Session]:
    """Lazily build (and memoize) the sync session factory."""
    global _engine, _session_maker
    if _session_maker is None:
        _engine = create_engine(_sync_url(), poolclass=NullPool, echo=settings.DB_ECHO)
        _session_maker = sessionmaker(bind=_engine, expire_on_commit=False, autoflush=False)
    return _session_maker


def dispose_sync_engine() -> None:
    """
    Drop the engine and force the next caller to rebuild it.

    Called from `_run_async`'s finally block alongside the async engine's
    dispose, and from the test suite's teardown. With NullPool there are no
    idle connections to release, so this is mostly about not carrying an engine
    across a fork.
    """
    global _engine, _session_maker
    if _engine is not None:
        _engine.dispose()
    _engine = None
    _session_maker = None
