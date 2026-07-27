"""
alembic/env.py — Alembic migration environment.

This file is loaded by every `alembic` CLI command.  Its responsibilities:
  1. Import ALL ORM models so that `target_metadata` is fully populated and
     `alembic revision --autogenerate` can detect every table.
  2. Register the pgvector Vector type so autogenerate doesn't error on
     `vector(1536)` columns.
  3. Configure the async engine from the same Settings object the app uses,
     ensuring migrations always run against the correct database.

IMPORTANT: Models MUST be imported here even if they are not referenced
elsewhere in this file — the import side-effect registers them with the
shared `Base.metadata`.
"""

from logging.config import fileConfig

# ─── pgvector type registration ───────────────────────────────────────────────
# Importing pgvector.sqlalchemy ensures the Vector type is registered with
# SQLAlchemy's type system before Alembic inspects any column definitions.
import pgvector.sqlalchemy  # noqa: F401  ← registration side-effect
from sqlalchemy import pool

from alembic import context

# ─── Shared declarative base ──────────────────────────────────────────────────
from src.db.base import Base
from src.modules.agents.models import (  # noqa: F401
    Agent,
    AgentMemory,
    AgentSession,
    AgentVersion,
)
from src.modules.audit_logs.models import AuditLog  # noqa: F401
from src.modules.auth.models import OrgMembership, Role, User  # noqa: F401

# Section 3.6 — Billing, Integrations, Settings (stubs)
from src.modules.billing.models import BillingAccount, BillingUsageRecord  # noqa: F401

# Section 3.5 — Chat, Notifications, Audit
from src.modules.chat.models import Chat, Message  # noqa: F401
from src.modules.executions.models import NodeExecution, WorkflowRun  # noqa: F401
from src.modules.integrations.models import Integration  # noqa: F401

# Section 3.4 — Knowledge Base & RAG
from src.modules.knowledge_base.models import (  # noqa: F401
    Document,
    DocumentChunk,
    KnowledgeBase,
    OCRResult,
)
from src.modules.notifications.models import Notification  # noqa: F401

# ─── Model imports (registration order: dependencies first) ───────────────────
#
# Section 3.1 — Identity & Tenancy
from src.modules.organizations.models import APIKey, Organization  # noqa: F401

# Section 3.3 — Agents, Tools, Prompts
from src.modules.prompts.models import Prompt, PromptVersion  # noqa: F401
from src.modules.settings.models import Setting  # noqa: F401
from src.modules.tools.models import Tool, ToolExecution  # noqa: F401
from src.modules.webhooks.models import Webhook  # noqa: F401

# Section 3.2 — Workflow Engine
from src.modules.workflows.models import (  # noqa: F401
    Workflow,
    WorkflowEdge,
    WorkflowNode,
    WorkflowVersion,
)
from src.modules.workspaces.models import Workspace  # noqa: F401

# ─── Alembic config ───────────────────────────────────────────────────────────

config = context.config

# Interpret the config file's logging configuration.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# `target_metadata` tells autogenerate what the schema SHOULD look like.
# Because every model above imports Base and uses Base as its declarative base,
# all tables are now registered in Base.metadata.
target_metadata = Base.metadata


def get_url() -> str:
    """
    Resolve the database URL from the application settings.

    We convert the async asyncpg URL to a sync psycopg2 URL for Alembic,
    which uses synchronous SQLAlchemy under the hood for offline/online
    migration execution.
    """
    from src.core.config import settings

    # Replace the async driver prefix with the sync one for Alembic.
    # asyncpg URL:  postgresql+asyncpg://user:pass@host/db
    # psycopg2 URL: postgresql+psycopg2://user:pass@host/db  (or just postgresql://)
    url = settings.DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://")
    return url


def run_migrations_offline() -> None:
    """
    Run migrations without a live DB connection (generates SQL script).
    Used with `alembic upgrade --sql` for reviewing migrations before applying.
    """
    url = get_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        # Ensure Alembic renders TIMESTAMPTZ, JSONB, etc. correctly.
        compare_type=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """
    Run migrations against a live DB connection.
    Standard mode used by `alembic upgrade head` in CI/CD.
    """
    from sqlalchemy import create_engine

    connectable = create_engine(
        get_url(),
        poolclass=pool.NullPool,  # no connection pooling for migration runs
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,  # detect column type changes
            compare_server_default=True,  # detect server_default changes
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
