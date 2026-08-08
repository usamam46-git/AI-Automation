"""
modules/tools/repository.py — data access for the tool registry.

`tools` carries a direct `organization_id` (Tool inherits TenantMixin, and the
initial schema emits the column, its index and the FK), so every query here
scopes on it directly — no join through `workspaces` is needed. RLS remains
defence-in-depth, not the mechanism.
"""

import uuid
from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import desc, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.modules.tools.models import Tool
from src.modules.workflows.models import Workflow, WorkflowNode, WorkflowVersion


class ToolRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def create(self, organization_id: uuid.UUID, data: dict) -> Tool:
        tool = Tool(organization_id=organization_id, **data)
        self.db.add(tool)
        await self.db.flush()
        return tool

    async def get_by_id(self, organization_id: uuid.UUID, tool_id: uuid.UUID) -> Tool | None:
        stmt = select(Tool).where(
            Tool.id == tool_id,
            Tool.organization_id == organization_id,
            Tool.is_active == True,  # noqa: E712
        )
        result = await self.db.execute(stmt)
        return result.scalar_one_or_none()

    async def list_by_org(
        self,
        organization_id: uuid.UUID,
        workspace_id: uuid.UUID | None = None,
        tool_type: str | None = None,
        cursor: str | None = None,
        limit: int = 50,
    ) -> Sequence[Tool]:
        stmt = (
            select(Tool)
            .where(
                Tool.organization_id == organization_id,
                Tool.is_active == True,  # noqa: E712
            )
            .order_by(desc(Tool.created_at))
            .limit(limit)
        )

        if workspace_id is not None:
            stmt = stmt.where(Tool.workspace_id == workspace_id)
        if tool_type is not None:
            stmt = stmt.where(Tool.tool_type == tool_type)

        if cursor:
            try:
                cursor_dt = datetime.fromisoformat(cursor)
                stmt = stmt.where(Tool.created_at < cursor_dt)
            except ValueError:
                pass  # Ignore invalid cursor — same convention as workspaces/executions.

        result = await self.db.execute(stmt)
        return result.scalars().all()

    async def get_many_by_ids(self, organization_id: uuid.UUID, tool_ids: Sequence[uuid.UUID]) -> list[Tool]:
        """
        Bulk fetch for publish validation and run-start resolution.

        Org-scoped and active-only, so a cross-org or soft-deleted id simply
        doesn't come back and the caller reports it as unresolvable — which is
        the same outcome as a genuinely nonexistent id, and deliberately so:
        distinguishing them would leak the existence of another org's row.
        """
        if not tool_ids:
            return []
        stmt = select(Tool).where(
            Tool.organization_id == organization_id,
            Tool.id.in_(list(tool_ids)),
            Tool.is_active == True,  # noqa: E712
        )
        result = await self.db.execute(stmt)
        return list(result.scalars().all())

    async def name_exists(self, workspace_id: uuid.UUID, name: str, exclude_id: uuid.UUID | None = None) -> bool:
        """
        Pre-check for the uq_tools_workspace_name constraint.

        Covers soft-deleted rows too (no is_active filter): the unique index is
        on (workspace_id, name) regardless of is_active, so a name freed by a
        soft delete is still taken as far as Postgres is concerned. Better a
        clean 409 than an IntegrityError surfacing as a 500.
        """
        stmt = select(func.count(Tool.id)).where(Tool.workspace_id == workspace_id, Tool.name == name)
        if exclude_id is not None:
            stmt = stmt.where(Tool.id != exclude_id)
        result = await self.db.execute(stmt)
        return result.scalar_one() > 0

    async def update(self, organization_id: uuid.UUID, tool_id: uuid.UUID, data: dict) -> Tool:
        stmt = (
            update(Tool)
            .where(
                Tool.id == tool_id,
                Tool.organization_id == organization_id,
                Tool.is_active == True,  # noqa: E712
            )
            .values(**data)
            .returning(Tool)
        )
        result = await self.db.execute(stmt)
        await self.db.flush()
        return result.scalar_one()

    async def soft_delete(self, organization_id: uuid.UUID, tool_id: uuid.UUID) -> None:
        stmt = update(Tool).where(Tool.id == tool_id, Tool.organization_id == organization_id).values(is_active=False)
        await self.db.execute(stmt)
        await self.db.flush()

    async def count_published_references(self, organization_id: uuid.UUID, tool_id: uuid.UUID) -> int:
        """
        How many nodes in *published* versions point at this tool.

        Published versions are immutable, so their nodes can never be edited to
        drop the reference — deleting the tool out from under them would turn
        every future run into a resolution failure. Drafts are not counted:
        they are still being edited, and blocking on one would make a tool
        undeletable for as long as someone has a stale tab open.
        """
        stmt = (
            select(func.count(WorkflowNode.id))
            .join(WorkflowVersion, WorkflowVersion.id == WorkflowNode.workflow_version_id)
            .join(Workflow, Workflow.id == WorkflowVersion.workflow_id)
            .where(
                # workflow_versions/workflow_nodes have no organization_id of
                # their own, so the scope comes from the owning workflow — the
                # join-through rule in root CLAUDE.md.
                Workflow.organization_id == organization_id,
                WorkflowVersion.published_at.is_not(None),
                WorkflowNode.config["tool_id"].astext == str(tool_id),
            )
        )
        result = await self.db.execute(stmt)
        return result.scalar_one()
