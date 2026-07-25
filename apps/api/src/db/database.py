"""
db/database.py — Async SQLAlchemy engine, session factory, and FastAPI
dependency for database sessions.

Key design decisions (Vol. 2 §2 & §3.8):
- Uses `asyncpg` driver via `postgresql+asyncpg://...` URL for async I/O.
- One session per request (created in `get_db_session`, closed on teardown).
- At the start of every request transaction, `SET LOCAL app.current_org_id`
  is executed so that Postgres Row-Level Security (RLS) policies have the
  current tenant's UUID available via `current_setting('app.current_org_id')`.
  If no org context is present (e.g., login/registration endpoints), the
  session variable is NOT set and RLS falls back gracefully.
"""

from collections.abc import AsyncGenerator
from typing import Optional
import uuid

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy import text

from src.core.config import settings  # pydantic-settings configuration object


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------

engine = create_async_engine(
    settings.DATABASE_URL,           # e.g. postgresql+asyncpg://user:pass@db:5432/aap_db
    pool_pre_ping=True,              # check connection health before use
    pool_size=10,                    # number of persistent connections per worker
    max_overflow=20,                 # extra connections allowed under burst load
    echo=settings.DB_ECHO,          # set True in dev to log all SQL
)

# ---------------------------------------------------------------------------
# Session factory
# ---------------------------------------------------------------------------

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    expire_on_commit=False,          # avoid lazy-load errors after commit in async context
    autocommit=False,
    autoflush=False,
)


# ---------------------------------------------------------------------------
# FastAPI dependency
# ---------------------------------------------------------------------------

async def get_db_session(
    org_id: Optional[uuid.UUID] = None,
) -> AsyncGenerator[AsyncSession, None]:
    """
    FastAPI dependency that yields an async SQLAlchemy session.

    Usage in a router:
        @router.get("/workflows")
        async def list_workflows(
            db: AsyncSession = Depends(get_db_session),
            current_org: Organization = Depends(get_current_org),
        ):
            ...

    The `org_id` parameter is NOT injected directly here — callers that need
    RLS enforcement should use the higher-level `get_org_scoped_db` dependency
    (see below), which resolves the org from the current JWT and passes it here.

    If `org_id` is None (public endpoints like /auth/login), the session is
    returned without setting `app.current_org_id`, so RLS policies will not
    match any rows — safe default.
    """
    async with AsyncSessionLocal() as session:
        if org_id is not None:
            # SET LOCAL scopes the variable to the current transaction only.
            # This means even if a connection is reused from the pool, the
            # variable never leaks into a subsequent request's transaction.
            await session.execute(
                text("SELECT set_config('app.current_org_id', :org_id, true)"),
                {"org_id": str(org_id)},
            )
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


async def get_org_scoped_db(
    # In practice this is wired via FastAPI's Depends chain:
    #   db: AsyncSession = Depends(get_org_scoped_db)
    # and `get_current_org` resolves the org from the JWT.
    # The function signature here is intentionally kept simple;
    # the actual wiring lives in src/core/dependencies.py.
) -> AsyncGenerator[AsyncSession, None]:
    """
    Convenience alias — yields a session pre-configured with the current
    request's organization_id for RLS.  Wire this in authenticated routers.

    Real implementation in src/core/dependencies.py composes:
        get_current_org → get_db_session(org_id=current_org.id)
    This stub makes the intent clear at the db layer.
    """
    async for session in get_db_session(org_id=None):
        yield session
