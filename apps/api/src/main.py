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
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

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
    description=(
        "AI Automation Platform — visual, LangGraph-backed workflow automation "
        "for finance, HR, and operations teams."
    ),
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
    allow_origins=["*"] if settings.DEBUG else [],  # tighten in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Health check (infrastructure smoke test)
# ---------------------------------------------------------------------------

@app.get("/health", tags=["Health"], summary="Health check")
async def health_check() -> dict:
    """
    Returns 200 OK if the API process is alive.

    Deep health (DB connectivity, Redis ping) can be added here later for
    use by a load balancer or k8s liveness probe.
    """
    return {"status": "ok", "env": settings.APP_ENV}
