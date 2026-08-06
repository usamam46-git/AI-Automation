import uuid

from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.encryption import decrypt_secret, encrypt_secret
from src.modules.integrations.models import Integration
from src.modules.integrations.repository import IntegrationRepository

_INTEGRATION_NAMES = {"openai_api_key": "OpenAI API Key"}


class IntegrationService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repository = IntegrationRepository(db)

    async def set_key(self, organization_id: uuid.UUID, type_: str, api_key: str) -> Integration:
        credentials = encrypt_secret(api_key)
        last_four = api_key[-4:]
        name = _INTEGRATION_NAMES.get(type_, type_)
        return await self.repository.upsert(organization_id, type_, name, credentials, last_four)

    async def get_status(self, organization_id: uuid.UUID, type_: str) -> Integration:
        integration = await self.repository.get_by_type(organization_id, type_)
        if integration is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"No '{type_}' integration configured for this organization.")
        return integration

    async def delete_key(self, organization_id: uuid.UUID, type_: str) -> None:
        await self.get_status(organization_id, type_)  # raises 404 if absent
        await self.repository.delete_by_type(organization_id, type_)

    async def get_decrypted_openai_key(self, organization_id: uuid.UUID) -> str | None:
        """
        Resolves the org's stored OpenAI key for LLMClient's `api_key_override` seam.
        Returns None when no key is stored, so callers fall back to
        settings.OPENAI_API_KEY exactly as before BYOK existed.
        """
        integration = await self.repository.get_by_type(organization_id, "openai_api_key")
        if integration is None or integration.credentials is None:
            return None
        return decrypt_secret(integration.credentials)
