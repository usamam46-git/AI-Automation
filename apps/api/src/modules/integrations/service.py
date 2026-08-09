import uuid

from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.encryption import decrypt_secret, encrypt_secret
from src.modules.audit_logs.schemas import AuditContext
from src.modules.audit_logs.service import AuditAction, AuditService
from src.modules.integrations.models import Integration
from src.modules.integrations.repository import IntegrationRepository

_INTEGRATION_NAMES = {"openai_api_key": "OpenAI API Key"}


class IntegrationService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repository = IntegrationRepository(db)
        self._audit = AuditService(db)

    async def set_key(self, organization_id: uuid.UUID, type_: str, api_key: str, context: AuditContext | None = None) -> Integration:
        credentials = encrypt_secret(api_key)
        last_four = api_key[-4:]
        name = _INTEGRATION_NAMES.get(type_, type_)
        # exists_by_type, NOT get_by_type — see that method's docstring. Loading
        # the entity here makes upsert()'s RETURNING hand back the stale row.
        replaced_existing = await self.repository.exists_by_type(organization_id, type_)
        integration = await self.repository.upsert(organization_id, type_, name, credentials, last_four)
        # Material: this key is what the org's LLM spend is billed against.
        # `last_four` only — the same fragment the status endpoint already
        # returns, and the only part of a key that ever appears anywhere.
        await self._audit.record(
            organization_id=organization_id,
            context=context or AuditContext.system(),
            action=AuditAction.INTEGRATION_CREDENTIAL_SET,
            resource_type="integration",
            resource_id=integration.id,
            metadata={
                "integration_type": type_,
                "last_four": last_four,
                "replaced_existing": replaced_existing,
            },
        )
        return integration

    async def get_status(self, organization_id: uuid.UUID, type_: str) -> Integration:
        integration = await self.repository.get_by_type(organization_id, type_)
        if integration is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"No '{type_}' integration configured for this organization.")
        return integration

    async def delete_key(self, organization_id: uuid.UUID, type_: str, context: AuditContext | None = None) -> None:
        integration = await self.get_status(organization_id, type_)  # raises 404 if absent
        # Recorded BEFORE the delete, so the audit row still has the id to point
        # at. Both statements are in the same transaction, so an audit row for a
        # delete that then rolls back cannot survive.
        await self._audit.record(
            organization_id=organization_id,
            context=context or AuditContext.system(),
            action=AuditAction.INTEGRATION_CREDENTIAL_DELETED,
            resource_type="integration",
            resource_id=integration.id,
            metadata={"integration_type": type_, "last_four": integration.last_four},
        )
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
