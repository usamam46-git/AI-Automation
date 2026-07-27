import uuid
from typing import Optional, Sequence

from datetime import datetime
from sqlalchemy import desc, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.modules.workspaces.models import Workspace


class WorkspaceRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def create(self, organization_id: uuid.UUID, data: dict) -> Workspace:
        workspace = Workspace(organization_id=organization_id, **data)
        self.db.add(workspace)
        await self.db.flush()
        return workspace

    async def get_by_id(self, organization_id: uuid.UUID, workspace_id: uuid.UUID) -> Optional[Workspace]:
        stmt = select(Workspace).where(
            Workspace.id == workspace_id,
            Workspace.organization_id == organization_id,
            Workspace.is_active == True,
        )
        result = await self.db.execute(stmt)
        return result.scalar_one_or_none()

    async def list_by_org(self, organization_id: uuid.UUID, cursor: Optional[str] = None, limit: int = 50) -> Sequence[Workspace]:
        stmt = (
            select(Workspace)
            .where(
                Workspace.organization_id == organization_id,
                Workspace.is_active == True,
            )
            .order_by(desc(Workspace.created_at))
            .limit(limit)
        )

        if cursor:
            try:
                cursor_dt = datetime.fromisoformat(cursor)
                stmt = stmt.where(Workspace.created_at < cursor_dt)
            except ValueError:
                pass  # Ignore invalid cursor

        result = await self.db.execute(stmt)
        return result.scalars().all()

    async def update(self, organization_id: uuid.UUID, workspace_id: uuid.UUID, data: dict) -> Workspace:
        stmt = (
            update(Workspace)
            .where(
                Workspace.id == workspace_id,
                Workspace.organization_id == organization_id,
                Workspace.is_active == True,
            )
            .values(**data)
            .returning(Workspace)
        )
        result = await self.db.execute(stmt)
        await self.db.flush()
        return result.scalar_one()

    async def soft_delete(self, organization_id: uuid.UUID, workspace_id: uuid.UUID) -> None:
        stmt = (
            update(Workspace)
            .where(
                Workspace.id == workspace_id,
                Workspace.organization_id == organization_id,
            )
            .values(is_active=False)
        )
        await self.db.execute(stmt)
        await self.db.flush()

    async def count_by_org(self, organization_id: uuid.UUID) -> int:
        from sqlalchemy import func

        stmt = select(func.count(Workspace.id)).where(
            Workspace.organization_id == organization_id,
            Workspace.is_active == True,
        )
        result = await self.db.execute(stmt)
        return result.scalar_one()
