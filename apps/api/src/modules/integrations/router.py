import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.dependencies import get_current_org, require_permission
from src.core.permissions import INTEGRATION_READ, INTEGRATION_WRITE
from src.db.database import get_db_session
from src.modules.integrations.schemas import IntegrationSetRequest, IntegrationStatusResponse
from src.modules.integrations.service import IntegrationService

router = APIRouter(tags=["integrations"])

# One integration type today. Mirrors the _TOOL_TYPES frozenset pattern in
# src/graphs/node_handlers.py — extensible later without overbuilding now.
_INTEGRATION_TYPES = frozenset({"openai_api_key"})


def get_integration_service(db: AsyncSession = Depends(get_db_session)) -> IntegrationService:
    return IntegrationService(db)


def _validate_type(integration_type: str) -> None:
    if integration_type not in _INTEGRATION_TYPES:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Unknown integration type '{integration_type}'.")


@router.put(
    "/{integration_type}",
    response_model=IntegrationStatusResponse,
    dependencies=[require_permission(INTEGRATION_WRITE)],
)
async def set_integration_key(
    integration_type: str,
    data: IntegrationSetRequest,
    organization_id: uuid.UUID = Depends(get_current_org),
    service: IntegrationService = Depends(get_integration_service),
) -> IntegrationStatusResponse:
    _validate_type(integration_type)
    return await service.set_key(organization_id, integration_type, data.api_key)


@router.get(
    "/{integration_type}",
    response_model=IntegrationStatusResponse,
    dependencies=[require_permission(INTEGRATION_READ)],
)
async def get_integration_status(
    integration_type: str,
    organization_id: uuid.UUID = Depends(get_current_org),
    service: IntegrationService = Depends(get_integration_service),
) -> IntegrationStatusResponse:
    _validate_type(integration_type)
    return await service.get_status(organization_id, integration_type)


@router.delete(
    "/{integration_type}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[require_permission(INTEGRATION_WRITE)],
)
async def delete_integration_key(
    integration_type: str,
    organization_id: uuid.UUID = Depends(get_current_org),
    service: IntegrationService = Depends(get_integration_service),
) -> None:
    _validate_type(integration_type)
    await service.delete_key(organization_id, integration_type)
