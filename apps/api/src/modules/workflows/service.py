"""
modules/workflows/service.py — Business logic for the Workflow shell.

Critical business rules:
1. Before creating, verify that workspace_id belongs to the caller's org — explicit
   query, never relying on RLS to produce a clean 404 (per Vol. 2 §1.1 / §3.8).
2. Status changes to "published" are allowed as a metadata flag only.
   TODO: Gate this behind graph compiler (§6.1) validation once compiler exists.
3. Soft-delete (archive) is the only deletion path — never hard-delete.
"""

import uuid
from typing import Optional, Sequence

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.events import WorkflowCreatedEvent, WorkflowUpdatedEvent, WorkflowArchivedEvent, event_bus
from src.modules.workflows.models import Workflow
from src.modules.workflows.repository import WorkflowRepository
from src.modules.workflows.schemas import WorkflowCreate, WorkflowUpdate
from src.modules.workspaces.models import Workspace


class WorkflowService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repository = WorkflowRepository(db)

    async def _verify_workspace_belongs_to_org(self, organization_id: uuid.UUID, workspace_id: uuid.UUID) -> None:
        """
        Explicit ownership check — returns clean 404 if workspace doesn't belong to org.
        This is intentional service-layer validation; RLS is a defense-in-depth backstop
        that must NOT be relied on to produce a human-readable error.
        """
        stmt = select(Workspace).where(
            Workspace.id == workspace_id,
            Workspace.organization_id == organization_id,
            Workspace.is_active == True,
        )
        result = await self.db.execute(stmt)
        if result.scalar_one_or_none() is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Workspace not found.",
            )

    async def create_workflow(self, organization_id: uuid.UUID, data: WorkflowCreate) -> Workflow:
        # Critical: verify workspace belongs to this org before inserting
        await self._verify_workspace_belongs_to_org(organization_id, data.workspace_id)

        create_data = data.model_dump()
        # Enum → string for SQLAlchemy
        create_data["trigger_type"] = (
            create_data["trigger_type"].value if hasattr(create_data["trigger_type"], "value") else create_data["trigger_type"]
        )
        create_data["status"] = "draft"

        workflow = await self.repository.create(organization_id, create_data)

        await event_bus.publish(WorkflowCreatedEvent(workflow_id=str(workflow.id), organization_id=str(organization_id)))
        return workflow

    async def get_workflow(self, organization_id: uuid.UUID, workflow_id: uuid.UUID) -> Workflow:
        workflow = await self.repository.get_by_id(organization_id, workflow_id)
        if not workflow:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workflow not found.")
        return workflow

    async def list_workflows(
        self,
        organization_id: uuid.UUID,
        workspace_id: Optional[uuid.UUID] = None,
        status_filter: Optional[str] = None,
        cursor: Optional[str] = None,
        limit: int = 50,
    ) -> Sequence[Workflow]:
        return await self.repository.list_by_org(
            organization_id,
            workspace_id=workspace_id,
            status=status_filter,
            cursor=cursor,
            limit=limit,
        )

    async def update_workflow(self, organization_id: uuid.UUID, workflow_id: uuid.UUID, data: WorkflowUpdate) -> Workflow:
        # Ensure it exists and belongs to this org
        await self.get_workflow(organization_id, workflow_id)

        update_data = data.model_dump(exclude_unset=True)
        if not update_data:
            return await self.get_workflow(organization_id, workflow_id)

        # Coerce enums to strings for SQLAlchemy
        if "trigger_type" in update_data and hasattr(update_data["trigger_type"], "value"):
            update_data["trigger_type"] = update_data["trigger_type"].value
        if "status" in update_data and hasattr(update_data["status"], "value"):
            update_data["status"] = update_data["status"].value

        # TODO (§6.1): When status is being changed to "published", validate against
        # graph compiler before allowing. For now this is a plain metadata flag.
        if update_data.get("status") == "published":
            pass  # Stub — compiler gate goes here

        workflow = await self.repository.update(organization_id, workflow_id, update_data)

        await event_bus.publish(WorkflowUpdatedEvent(workflow_id=str(workflow.id), organization_id=str(organization_id)))
        return workflow

    async def delete_workflow(self, organization_id: uuid.UUID, workflow_id: uuid.UUID) -> None:
        await self.get_workflow(organization_id, workflow_id)
        await self.repository.soft_delete(organization_id, workflow_id)

        await event_bus.publish(WorkflowArchivedEvent(workflow_id=str(workflow_id), organization_id=str(organization_id)))
