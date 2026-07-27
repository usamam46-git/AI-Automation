"""
modules/workflows/repository.py — SQLAlchemy queries for the Workflow shell.

Scope: create, get, list (with workspace_id/status filters), update, soft-delete.
OUT OF SCOPE: workflow_versions, workflow_nodes, workflow_edges.
"""

import uuid
from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import desc, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.modules.workflows.models import Workflow


class WorkflowRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def create(self, organization_id: uuid.UUID, data: dict) -> Workflow:
        workflow = Workflow(organization_id=organization_id, **data)
        self.db.add(workflow)
        await self.db.flush()
        return workflow

    async def get_by_id(self, organization_id: uuid.UUID, workflow_id: uuid.UUID) -> Workflow | None:
        stmt = select(Workflow).where(
            Workflow.id == workflow_id,
            Workflow.organization_id == organization_id,
            Workflow.status != "archived",
        )
        result = await self.db.execute(stmt)
        return result.scalar_one_or_none()

    async def list_by_org(
        self,
        organization_id: uuid.UUID,
        workspace_id: uuid.UUID | None = None,
        status: str | None = None,
        cursor: str | None = None,
        limit: int = 50,
    ) -> Sequence[Workflow]:
        stmt = select(Workflow).where(Workflow.organization_id == organization_id).order_by(desc(Workflow.created_at)).limit(limit)

        if workspace_id is not None:
            stmt = stmt.where(Workflow.workspace_id == workspace_id)

        if status is not None:  # noqa: SIM108
            stmt = stmt.where(Workflow.status == status)
        else:
            # By default, exclude archived workflows from list
            stmt = stmt.where(Workflow.status != "archived")

        if cursor:
            try:
                cursor_dt = datetime.fromisoformat(cursor)
                stmt = stmt.where(Workflow.created_at < cursor_dt)
            except ValueError:
                pass

        result = await self.db.execute(stmt)
        return result.scalars().all()

    async def update(self, organization_id: uuid.UUID, workflow_id: uuid.UUID, data: dict) -> Workflow:
        stmt = (
            update(Workflow)
            .where(
                Workflow.id == workflow_id,
                Workflow.organization_id == organization_id,
            )
            .values(**data)
            .returning(Workflow)
        )
        result = await self.db.execute(stmt)
        await self.db.flush()
        return result.scalar_one()

    async def soft_delete(self, organization_id: uuid.UUID, workflow_id: uuid.UUID) -> None:
        """Archive a workflow (soft delete). Never hard-deletes."""
        stmt = (
            update(Workflow)
            .where(
                Workflow.id == workflow_id,
                Workflow.organization_id == organization_id,
            )
            .values(status="archived")
        )
        await self.db.execute(stmt)
        await self.db.flush()

    async def count_active_for_workspace(self, organization_id: uuid.UUID, workspace_id: uuid.UUID) -> int:
        """Count non-archived workflows in a workspace. Used by workspace deletion guard."""
        stmt = select(func.count(Workflow.id)).where(
            Workflow.workspace_id == workspace_id,
            Workflow.organization_id == organization_id,
            Workflow.status != "archived",
        )
        result = await self.db.execute(stmt)
        return result.scalar_one()
