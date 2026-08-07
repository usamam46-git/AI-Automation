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
from collections.abc import Sequence
from datetime import datetime
from typing import Any

from sqlalchemy import Row, desc, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from src.modules.executions.models import NodeExecution, WorkflowRun
from src.modules.workflows.models import Workflow, WorkflowVersion


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
            .options(
                selectinload(WorkflowRun.node_executions),
                # Required by WorkflowRun's workflow_id/workflow_name/version_number
                # properties, which WorkflowRunResponse reads. Without this the
                # properties trigger a lazy load on an async session -> MissingGreenlet.
                selectinload(WorkflowRun.workflow_version).selectinload(WorkflowVersion.workflow),
            )
        )
        result = await self.db.execute(stmt)
        return result.scalar_one_or_none()

    async def list_runs(
        self,
        organization_id: uuid.UUID,
        workflow_id: uuid.UUID | None = None,
        status: str | None = None,
        cursor: str | None = None,
        limit: int = 50,
    ) -> Sequence[Row[tuple[WorkflowRun, uuid.UUID, str, int]]]:
        """
        List runs for an org, newest first, with the owning workflow's id/name and
        the version number joined on.

        Cursor convention is the one established by WorkflowRepository.list_by_org:
        the cursor is the raw ISO-8601 created_at of the previous page's last row,
        and an unparseable cursor is ignored rather than rejected.

        Note: node_executions are deliberately NOT loaded — that is the whole point
        of the WorkflowRunSummary shape. Use get_run for the full audit trail.

        Unlike the workflows list, this applies no default filter on the *workflow's*
        status: a run's history must not disappear because its workflow was archived
        later. The `status` argument here filters run status, not workflow status.
        """
        stmt = (
            select(WorkflowRun, Workflow.id, Workflow.name, WorkflowVersion.version_number)
            .join(WorkflowVersion, WorkflowVersion.id == WorkflowRun.workflow_version_id)
            .join(Workflow, Workflow.id == WorkflowVersion.workflow_id)
            # Direct column — workflow_runs.organization_id is denormalized on
            # purpose, so tenant scoping needs no join. The joins above exist only
            # for the workflow name and the workflow_id filter.
            .where(WorkflowRun.organization_id == organization_id)
            .order_by(desc(WorkflowRun.created_at))
            .limit(limit)
        )

        if workflow_id is not None:
            stmt = stmt.where(WorkflowVersion.workflow_id == workflow_id)

        if status is not None:
            stmt = stmt.where(WorkflowRun.status == status)

        if cursor:
            try:
                cursor_dt = datetime.fromisoformat(cursor)
                stmt = stmt.where(WorkflowRun.created_at < cursor_dt)
            except ValueError:
                pass  # Ignore invalid cursor

        result = await self.db.execute(stmt)
        return result.all()

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
