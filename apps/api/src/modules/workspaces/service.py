import uuid
from typing import Optional, Sequence

from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.events import WorkspaceCreatedEvent, WorkspaceDeletedEvent, WorkspaceUpdatedEvent, event_bus
from src.modules.workspaces.repository import WorkspaceRepository
from src.modules.workspaces.schemas import WorkspaceCreate, WorkspaceUpdate
from src.modules.workspaces.models import Workspace


class WorkspaceService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repository = WorkspaceRepository(db)

    async def create_workspace(self, organization_id: uuid.UUID, data: WorkspaceCreate) -> Workspace:
        # Check if this is the first workspace
        count = await self.repository.count_by_org(organization_id)
        is_default = count == 0

        create_data = data.model_dump()
        create_data["is_default"] = is_default

        workspace = await self.repository.create(organization_id, create_data)

        await event_bus.publish(WorkspaceCreatedEvent(workspace_id=str(workspace.id), organization_id=str(organization_id)))
        return workspace

    async def get_workspace(self, organization_id: uuid.UUID, workspace_id: uuid.UUID) -> Workspace:
        workspace = await self.repository.get_by_id(organization_id, workspace_id)
        if not workspace:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found")
        return workspace

    async def list_workspaces(self, organization_id: uuid.UUID, cursor: Optional[str] = None, limit: int = 50) -> Sequence[Workspace]:
        return await self.repository.list_by_org(organization_id, cursor, limit)

    async def update_workspace(self, organization_id: uuid.UUID, workspace_id: uuid.UUID, data: WorkspaceUpdate) -> Workspace:
        workspace = await self.get_workspace(organization_id, workspace_id)

        update_data = data.model_dump(exclude_unset=True)
        if update_data:
            workspace = await self.repository.update(organization_id, workspace_id, update_data)

            await event_bus.publish(WorkspaceUpdatedEvent(workspace_id=str(workspace.id), organization_id=str(organization_id)))

        return workspace

    async def delete_workspace(self, organization_id: uuid.UUID, workspace_id: uuid.UUID) -> None:
        workspace = await self.get_workspace(organization_id, workspace_id)

        # Check for non-archived workflows blocking deletion
        from src.modules.workflows.repository import WorkflowRepository

        wf_repo = WorkflowRepository(self.db)
        blocking_workflows = await wf_repo.count_active_for_workspace(organization_id, workspace_id)

        if blocking_workflows > 0:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Cannot delete workspace because it has {blocking_workflows} non-archived workflow(s) attached.",
            )

        await self.repository.soft_delete(organization_id, workspace_id)

        await event_bus.publish(WorkspaceDeletedEvent(workspace_id=str(workspace.id), organization_id=str(organization_id)))
