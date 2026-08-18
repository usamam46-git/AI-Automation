"""
main.py — FastAPI application entry point.

Responsibilities:
  - Create the FastAPI application instance with metadata.
  - Register the lifespan context manager (startup / shutdown hooks).
  - Mount the API router(s).
  - Register global middleware (CORS, trusted hosts, etc.)
  - Register the global exception handler.

The lifespan pattern (contextlib.asynccontextmanager) is the modern FastAPI
approach (replacing the deprecated @app.on_event("startup") / ("shutdown")).
Every infrastructure resource (DB engine, Redis pool) is initialized here and
torn down cleanly on shutdown.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import src.db.models  # noqa: F401 — register full ORM graph at startup
from src.core.config import settings
from src.core.redis import close_redis, init_redis

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Lifespan — startup & shutdown
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """
    Manage application-level resources.

    Resources initialized here:
      - Redis connection pool  (§4 Caching Strategy)

    Resources to add later:
      - SQLAlchemy async engine / session factory  (already used via Alembic)
      - Celery app warm-up check                   (§5 Background Jobs)
    """
    # ── Startup ──────────────────────────────────────────────────────────────
    logger.info("Starting AI Automation Platform API [env=%s]", settings.APP_ENV)

    await init_redis()

    from src.db.database import AsyncSessionLocal
    from src.db.seed_roles import seed_system_roles

    async with AsyncSessionLocal() as session:
        await seed_system_roles(session)
    logger.info("System roles seeded (idempotent).")

    logger.info("All startup resources initialized.")

    yield  # Application is running

    # ── Shutdown ─────────────────────────────────────────────────────────────
    logger.info("Shutting down — releasing resources.")

    await close_redis()

    logger.info("Shutdown complete.")


# ---------------------------------------------------------------------------
# Application factory
# ---------------------------------------------------------------------------

app = FastAPI(
    title=settings.APP_NAME,
    version="0.1.0",
    description=("AI Automation Platform — visual, LangGraph-backed workflow automation " "for finance, HR, and operations teams."),
    docs_url="/api/docs" if settings.DEBUG else None,
    redoc_url="/api/redoc" if settings.DEBUG else None,
    openapi_url="/api/openapi.json" if settings.DEBUG else None,
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# Middleware
# ---------------------------------------------------------------------------

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"] if settings.DEBUG else [],  # tighten in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Health check (infrastructure smoke test)
# ---------------------------------------------------------------------------

from src.modules.analytics.router import router as analytics_router
from src.modules.audit_logs.router import router as audit_logs_router
from src.modules.auth.router import router as auth_router
from src.modules.executions.router import router as executions_router
from src.modules.integrations.router import router as integrations_router
from src.modules.knowledge_base.router import router as knowledge_base_router
from src.modules.organizations.router import router as organizations_router
from src.modules.tools.router import router as tools_router
from src.modules.workflows.router import router as workflows_router
from src.modules.workspaces.router import router as workspaces_router

# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------
app.include_router(auth_router, prefix="/api/v1/auth", tags=["auth"])
app.include_router(workspaces_router, prefix="/api/v1/workspaces", tags=["workspaces"])
app.include_router(workflows_router, prefix="/api/v1/workflows", tags=["workflows"])
# Executions router mounts at /api/v1 (no prefix) because its endpoints span
# two path prefixes: /api/v1/workflows/{id}/run and /api/v1/executions/{id}
app.include_router(executions_router, prefix="/api/v1", tags=["executions"])
app.include_router(integrations_router, prefix="/api/v1/integrations", tags=["integrations"])
app.include_router(tools_router, prefix="/api/v1/tools", tags=["tools"])
# Knowledge bases and their documents. Kebab-case path, matching audit-logs.
app.include_router(knowledge_base_router, prefix="/api/v1/knowledge-bases", tags=["knowledge-bases"])
# Read-only by construction — see the module docstring. Vol. 2 §700 requires
# that no UPDATE/DELETE route exists for audit_logs.
app.include_router(audit_logs_router, prefix="/api/v1/audit-logs", tags=["audit-logs"])
app.include_router(organizations_router, prefix="/api/v1/organizations", tags=["organizations"])
# Read-only aggregates over workflow_runs — owns no tables, gated on execution:read.
app.include_router(analytics_router, prefix="/api/v1/analytics", tags=["analytics"])


@app.get("/health", tags=["Health"], summary="Health check")
async def health_check() -> dict:
    """
    Returns 200 OK if the API process is alive.

    Deep health (DB connectivity, Redis ping) can be added here later for
    use by a load balancer or k8s liveness probe.
    """
    return {"status": "ok", "env": settings.APP_ENV}
