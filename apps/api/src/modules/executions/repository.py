"""
modules/executions/repository.py — SQLAlchemy queries for WorkflowRun and
NodeExecution.

Layering rule: no business logic here — only DB access.
Tenant isolation: HTTP-facing methods always filter by organization_id.
Internal methods (used by Celery workers) query by run_id only and are
suffixed _internal to make the scope explicit.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from src.modules.executions.models import NodeExecution, WorkflowRun


class ExecutionRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    # ------------------------------------------------------------------
    # WorkflowRun — HTTP-scoped (organization_id required)
    # ------------------------------------------------------------------

    async def create_run(
        self,
        *,
        organization_id: uuid.UUID,
        workflow_version_id: uuid.UUID,
        trigger_payload: dict[str, Any] | None,
    ) -> WorkflowRun:
        run = WorkflowRun(
            organization_id=organization_id,
            workflow_version_id=workflow_version_id,
            status="pending",
            trigger_payload=trigger_payload,
        )
        self.db.add(run)
        await self.db.flush()
        await self.db.refresh(run)
        return run

    async def get_run(
        self,
        organization_id: uuid.UUID,
        run_id: uuid.UUID,
    ) -> WorkflowRun | None:
        """Return run with node_executions, scoped to org."""
        stmt = (
            select(WorkflowRun)
            .where(
                WorkflowRun.id == run_id,
                WorkflowRun.organization_id == organization_id,
            )
            .options(selectinload(WorkflowRun.node_executions))
        )
        result = await self.db.execute(stmt)
        return result.scalar_one_or_none()

    async def update_run_status(
        self,
        organization_id: uuid.UUID,
        run_id: uuid.UUID,
        status: str,
        **extra_fields: Any,
    ) -> None:
        """Update run status + any extra columns. Org-scoped."""
        values: dict[str, Any] = {"status": status, **extra_fields}
        await self.db.execute(
            update(WorkflowRun)
            .where(
                WorkflowRun.id == run_id,
                WorkflowRun.organization_id == organization_id,
            )
            .values(**values)
        )
        await self.db.flush()

    # ------------------------------------------------------------------
    # NodeExecution — idempotency check
    # ------------------------------------------------------------------

    async def get_succeeded_node_execution(
        self,
        workflow_run_id: uuid.UUID,
        node_key: str,
        attempt: int,
    ) -> NodeExecution | None:
        """Return an existing succeeded row for idempotency checks on Celery retry."""
        stmt = select(NodeExecution).where(
            NodeExecution.workflow_run_id == workflow_run_id,
            NodeExecution.node_key == node_key,
            NodeExecution.attempt == attempt,
            NodeExecution.status == "succeeded",
        )
        result = await self.db.execute(stmt)
        return result.scalar_one_or_none()
