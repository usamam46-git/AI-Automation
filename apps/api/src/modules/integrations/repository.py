import uuid

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from src.modules.integrations.models import Integration


class IntegrationRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def upsert(self, organization_id: uuid.UUID, type_: str, name: str, credentials: bytes, last_four: str) -> Integration:
        stmt = (
            pg_insert(Integration)
            .values(
                organization_id=organization_id,
                type=type_,
                name=name,
                credentials=credentials,
                last_four=last_four,
            )
            .on_conflict_do_update(
                index_elements=[Integration.organization_id, Integration.type],
                set_={"credentials": credentials, "last_four": last_four, "name": name},
            )
            .returning(Integration)
        )
        result = await self.db.execute(stmt)
        await self.db.flush()
        return result.scalar_one()

    async def get_by_type(self, organization_id: uuid.UUID, type_: str) -> Integration | None:
        stmt = select(Integration).where(
            Integration.organization_id == organization_id,
            Integration.type == type_,
        )
        result = await self.db.execute(stmt)
        return result.scalar_one_or_none()

    async def delete_by_type(self, organization_id: uuid.UUID, type_: str) -> None:
        stmt = delete(Integration).where(
            Integration.organization_id == organization_id,
            Integration.type == type_,
        )
        await self.db.execute(stmt)
        await self.db.flush()
