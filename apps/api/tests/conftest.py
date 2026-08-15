"""
tests/conftest.py — shared fixtures.

Test isolation (added 2026-08-08)
--------------------------------
Before this, `pytest` had no Postgres or broker isolation: fixture rows were
committed straight into whatever database `DATABASE_URL` pointed at, and every
endpoint that called `execute_workflow.delay(...)` published a real task. Run
against a Docker-Compose dev stack that meant a routine test run left ~130
fixture orgs in `aap_db` and handed the live worker a queue of runs to churn
through. Two autouse fixtures below close that.

**Why truncate-after-test and not the usual wrap-each-test-in-a-rolled-back-
transaction trick?** That pattern needs every session to share one Connection,
and this suite cannot:

- LangGraph's `AsyncBackgroundExecutor` submits `aput` and `aput_writes` as
  independent concurrent asyncio tasks (see the `PostgresSaver` note in
  apps/api/CLAUDE.md). Two concurrent statements on one asyncpg connection is
  `InterfaceError: another operation is in progress`, so every test that drives
  `_stream_graph` dies.
- `TimestampMixin.created_at` is `server_default=func.now()`, and Postgres'
  `now()` is transaction start time. Collapsing a test into a single
  transaction gives every row an identical `created_at`, which breaks the
  cursor-pagination tests — they page on exactly that column.

Truncating between tests keeps real connections, real commits and a real clock,
and still leaves the database as clean as it was found. Full `testcontainers`
(Vol. 7 §4) is deliberately NOT wired up — it costs a day and slows local
startup; this gets the isolation without the infrastructure.
"""

import asyncio
import os
from collections.abc import AsyncGenerator
from unittest.mock import patch
from urllib.parse import urlparse

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.config import settings
from src.core.redis import close_redis, get_redis, init_redis
from src.db.database import async_session_maker, engine
from src.db.seed_roles import seed_system_roles
from src.db.sync_database import dispose_sync_engine
from src.main import app

# ---------------------------------------------------------------------------
# Destructive-run guard — must stay ABOVE every fixture
# ---------------------------------------------------------------------------
#
# The isolation described above is destructive by design: `_clean_database`
# TRUNCATEs every `public` table around EVERY test, against whatever database
# `DATABASE_URL` happens to name. That is correct for a test database and
# catastrophic for a development one, and nothing distinguished the two.
#
# On 2026-08-15 this suite was run inside the `aap_api` container, where
# DATABASE_URL points at the dev database. It destroyed the org, the user, a
# published workflow and its whole run history. Nothing warned, and the damage
# only surfaced at the next login attempt as "system roles not seeded" — the
# `roles` table having been truncated along with everything else.
#
# The guard is deliberately a hard `pytest.exit` at collection time rather than
# a fixture: by the time fixtures run, the first TRUNCATE is already imminent.
# `AAP_ALLOW_DESTRUCTIVE_TESTS=1` is the escape hatch for anyone who genuinely
# means it (a throwaway stack, CI with an ephemeral database whose name does not
# happen to match).
_TEST_DB_SUFFIX = "_test"
_ALLOW_DESTRUCTIVE_ENV = "AAP_ALLOW_DESTRUCTIVE_TESTS"


def _database_name(url: str) -> str:
    """The database name from a SQLAlchemy URL, without needing a driver."""
    return urlparse(url).path.lstrip("/").split("?")[0]


def _assert_safe_test_database() -> None:
    if os.getenv(_ALLOW_DESTRUCTIVE_ENV):
        return

    name = _database_name(settings.DATABASE_URL)
    if name.endswith(_TEST_DB_SUFFIX):
        return

    pytest.exit(
        f"\n\nRefusing to run: DATABASE_URL names the database '{name}', which does not end "
        f"in '{_TEST_DB_SUFFIX}'.\n\n"
        "This suite TRUNCATEs every table in the `public` schema around every single test. "
        "Pointed at a development database it destroys orgs, users, workflows and run "
        "history, and the first symptom is a failed login.\n\n"
        "Use a dedicated test database:\n"
        "    createdb aap_test  (or: docker exec aap_postgres createdb -U aap_user aap_test)\n"
        "    DATABASE_URL=postgresql+asyncpg://aap_user:aap_pass@postgres:5432/aap_test \\\n"
        "        python -m alembic upgrade head\n"
        "    DATABASE_URL=postgresql+asyncpg://aap_user:aap_pass@postgres:5432/aap_test \\\n"
        "        python -m pytest\n\n"
        f"If you really mean to truncate '{name}', set {_ALLOW_DESTRUCTIVE_ENV}=1.\n",
        returncode=2,
    )


_assert_safe_test_database()

# Alembic's bookkeeping table is the one thing in `public` that must survive —
# wiping it would make the next run think the database is unmigrated. Everything
# else is fair game, including `roles`, which `setup_services` re-seeds per test.
_PRESERVED_TABLES = frozenset({"alembic_version"})


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()


async def _truncate_all_tables() -> None:
    """
    Wipe every data table in one statement.

    Read from `pg_tables` rather than `Base.metadata` on purpose: metadata only
    knows about tables some module happened to import, and a table that escapes
    the list is exactly the leak this fixture exists to prevent. One combined
    TRUNCATE lets Postgres resolve the FK graph itself; CASCADE covers anything
    referenced from outside the list.
    """
    async with engine.begin() as conn:
        rows = await conn.execute(text("SELECT tablename FROM pg_tables WHERE schemaname = 'public'"))
        tables = [t for (t,) in rows if t not in _PRESERVED_TABLES]
        if tables:
            qualified = ", ".join(f'public."{t}"' for t in tables)
            await conn.execute(text(f"TRUNCATE TABLE {qualified} RESTART IDENTITY CASCADE"))


@pytest.fixture(autouse=True)
async def _clean_database() -> AsyncGenerator[None, None]:
    """
    Truncate before *and* after each test.

    Before, so a run is not polluted by whatever a previous crashed run or a
    manual poke at the dev stack left behind. After, so `pytest` leaves the
    database the way it found it. Declared ahead of `setup_services` because
    pytest resolves same-scope autouse fixtures in definition order, and the
    pre-test truncate must not wipe the roles that fixture seeds.
    """
    await _truncate_all_tables()
    await _clear_run_quota_keys()
    try:
        yield
    finally:
        # ToolExecutionLogger writes through a second, synchronous engine
        # (src/db/sync_database.py). Drop it before truncating so no connection
        # is holding a lock on a table we're about to TRUNCATE.
        dispose_sync_engine()
        await _truncate_all_tables()
        await _clear_run_quota_keys()


async def _clear_run_quota_keys() -> None:
    """
    Drop the per-org daily run-quota counters (Vol. 2 §667) from Redis.

    Truncating Postgres is not enough: the quota lives in Redis, so without this
    a test that exhausts an allowance leaves the counter behind and `pytest`
    stops being idempotent against a dev stack sharing that Redis.

    Scoped to `rate_limit:org_runs:*` on purpose — NOT `flushdb`. The same Redis
    holds the JWT blocklist, the permission cache and the compiled-graph cache
    for whatever else is pointed at it, and a blanket flush during a test run
    would log out a developer's live session.
    """
    from src.core.redis import get_redis_client

    redis = await get_redis_client()
    keys = [key async for key in redis.scan_iter(match="rate_limit:org_runs:*")]
    if keys:
        await redis.delete(*keys)


@pytest.fixture
def celery_calls() -> list[tuple[str, tuple, dict]]:
    """Recorded `.delay(...)` calls, as (task_name, args, kwargs)."""
    return []


@pytest.fixture(autouse=True)
def _stub_celery_dispatch(celery_calls: list[tuple[str, tuple, dict]]):
    """
    Keep `.delay(...)` off the real broker.

    `ExecutionService` imports the tasks inside the method body, so the name is
    resolved from `src.workers.graph_tasks` at call time and patching the task
    objects' `.delay` here reaches it. Tests that need a graph to actually run
    already await `_stream_graph()` directly and are unaffected; depend on
    `celery_calls` to assert on what would have been dispatched.

    Imported lazily because `src.workers.graph_tasks` pulls in LangGraph and the
    graph compiler — no reason to make every test session pay that at collection.
    """
    from src.workers.document_tasks import ingest_document
    from src.workers.graph_tasks import execute_workflow, resume_workflow
    from src.workers.trigger_tasks import dispatch_due_schedules

    def _recorder(name: str):
        def _delay(*args, **kwargs):
            celery_calls.append((name, args, kwargs))
            return None

        return _delay

    with (
        patch.object(execute_workflow, "delay", _recorder("execute_workflow")),
        patch.object(resume_workflow, "delay", _recorder("resume_workflow")),
        # The beat tick is never dispatched by application code (only by beat
        # itself), but stub it anyway so the "a test run sends the worker zero
        # jobs" invariant holds even if a future test reaches for it.
        patch.object(dispatch_due_schedules, "delay", _recorder("dispatch_due_schedules")),
        # Every document upload dispatches this. Without the stub, uploading
        # in a test hands the live worker_documents container a real job —
        # which would then embed against the real OpenAI key.
        patch.object(ingest_document, "delay", _recorder("ingest_document")),
    ):
        yield


@pytest.fixture
def stored_objects() -> dict[str, bytes]:
    """The in-memory object store standing in for MinIO. Keyed by object key."""
    return {}


@pytest.fixture(autouse=True)
def _stub_object_storage(stored_objects: dict[str, bytes]):
    """
    Keep document uploads off real object storage.

    Same reasoning as `_stub_celery_dispatch` above, and the same shape: the test
    suite must not require infrastructure that only exists in the Docker compose
    stack. **CI runs Postgres and Redis and nothing else** — there is no MinIO
    service — so every upload test failed there while passing locally inside the
    compose network. Nine of them, on the first push.

    An in-memory dict rather than per-test mocks, so an upload followed by an
    ingestion round-trips the real bytes and the pipeline is exercised end to end
    without the network. `core/storage.py` itself is thin boto3 glue and is
    verified against the live service by hand, not here.
    """
    from src.core import storage

    def _put_sync(key: str, data: bytes, content_type: str) -> None:
        stored_objects[key] = data

    def _get_sync(key: str) -> bytes:
        try:
            return stored_objects[key]
        except KeyError as exc:
            raise storage.StorageError(f"Could not read object '{key}': not in the test store") from exc

    def _delete_sync(key: str) -> None:
        stored_objects.pop(key, None)

    async def _put(key: str, data: bytes, content_type: str) -> None:
        _put_sync(key, data, content_type)

    async def _get(key: str) -> bytes:
        return _get_sync(key)

    async def _delete(key: str) -> None:
        _delete_sync(key)

    with (
        patch.object(storage, "put_object", _put),
        patch.object(storage, "get_object", _get),
        patch.object(storage, "delete_object", _delete),
        patch.object(storage, "put_object_sync", _put_sync),
        patch.object(storage, "get_object_sync", _get_sync),
        patch.object(storage, "delete_object_sync", _delete_sync),
        patch.object(storage, "ensure_bucket_sync", lambda: None),
    ):
        yield


@pytest.fixture(autouse=True)
async def setup_services():
    """Initialize Redis, flush it for test isolation, and seed system roles."""
    await init_redis()
    redis = await get_redis()
    await redis.flushdb()

    # Seeded per test because `_clean_database` truncates `roles` around each one.
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
