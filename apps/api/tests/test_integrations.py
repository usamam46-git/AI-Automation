"""
tests/test_integrations.py — BYOK OpenAI key storage (Vol. 2 §13).

Coverage:
- Unit: AES-256-GCM round trip (src/core/encryption.py)
- Unit: IntegrationService against a mocked repository
- Integration: PUT/GET/DELETE lifecycle over HTTP, masking, cross-tenant isolation
- Integration: the execution-path wiring — a stored org key beats the
  settings.OPENAI_API_KEY fallback when `_stream_graph` compiles the graph
"""

import uuid
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from httpx import AsyncClient
from test_agent_nodes import AGENT_CONFIG, EXTRACTION, _patched_openai, _publish_agent_workflow
from test_executions import _load_version
from test_workflows import register_and_get_token

from src.core.encryption import decrypt_secret, encrypt_secret
from src.modules.integrations.models import Integration
from src.modules.integrations.service import IntegrationService
from src.workers.graph_tasks import _stream_graph

# ---------------------------------------------------------------------------
# Unit — encryption round trip
# ---------------------------------------------------------------------------


def test_encrypt_decrypt_round_trip():
    blob = encrypt_secret("sk-super-secret-key")
    assert decrypt_secret(blob) == "sk-super-secret-key"


def test_encrypt_is_nondeterministic():
    """Different nonce each call, so identical plaintext never produces identical ciphertext."""
    assert encrypt_secret("sk-same") != encrypt_secret("sk-same")


def test_decrypt_rejects_tampered_blob():
    from cryptography.exceptions import InvalidTag

    blob = bytearray(encrypt_secret("sk-super-secret-key"))
    blob[-1] ^= 0xFF  # flip a bit in the tag
    with pytest.raises(InvalidTag):
        decrypt_secret(bytes(blob))


# ---------------------------------------------------------------------------
# Unit — IntegrationService (mocked repository)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_set_key_encrypts_before_storing():
    mock_db = AsyncMock()
    service = IntegrationService(mock_db)
    service.repository.upsert = AsyncMock(side_effect=lambda org_id, type_, name, credentials, last_four: Integration(
        organization_id=org_id, type=type_, name=name, credentials=credentials, last_four=last_four
    ))

    org_id = uuid.uuid4()
    result = await service.set_key(org_id, "openai_api_key", "sk-abcd1234")

    assert result.last_four == "1234"
    assert result.credentials != b"sk-abcd1234"  # never stored raw
    assert decrypt_secret(result.credentials) == "sk-abcd1234"


@pytest.mark.asyncio
async def test_get_status_404_when_absent():
    mock_db = AsyncMock()
    service = IntegrationService(mock_db)
    service.repository.get_by_type = AsyncMock(return_value=None)

    with pytest.raises(HTTPException) as exc:
        await service.get_status(uuid.uuid4(), "openai_api_key")
    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_get_decrypted_openai_key_returns_none_when_absent():
    mock_db = AsyncMock()
    service = IntegrationService(mock_db)
    service.repository.get_by_type = AsyncMock(return_value=None)

    assert await service.get_decrypted_openai_key(uuid.uuid4()) is None


@pytest.mark.asyncio
async def test_get_decrypted_openai_key_round_trips_stored_value():
    mock_db = AsyncMock()
    service = IntegrationService(mock_db)
    stored = Integration(credentials=encrypt_secret("sk-live-key"), last_four="-key")
    service.repository.get_by_type = AsyncMock(return_value=stored)

    assert await service.get_decrypted_openai_key(uuid.uuid4()) == "sk-live-key"


# ---------------------------------------------------------------------------
# Integration — HTTP lifecycle
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_set_get_delete_lifecycle(client: AsyncClient):
    data = await register_and_get_token(client, "byok")
    headers = {"Authorization": f"Bearer {data['access_token']}"}

    # No key yet
    resp = await client.get("/api/v1/integrations/openai_api_key", headers=headers)
    assert resp.status_code == 404

    # Set
    resp = await client.put("/api/v1/integrations/openai_api_key", json={"api_key": "sk-abcd1234wxyz"}, headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["type"] == "openai_api_key"
    assert body["last_four"] == "wxyz"
    assert "api_key" not in body
    assert "credentials" not in body

    # Status
    resp = await client.get("/api/v1/integrations/openai_api_key", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["last_four"] == "wxyz"

    # Delete
    resp = await client.delete("/api/v1/integrations/openai_api_key", headers=headers)
    assert resp.status_code == 204

    # Gone
    resp = await client.get("/api/v1/integrations/openai_api_key", headers=headers)
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_replace_key_upserts_not_duplicates(client: AsyncClient):
    data = await register_and_get_token(client, "byok-replace")
    headers = {"Authorization": f"Bearer {data['access_token']}"}

    await client.put("/api/v1/integrations/openai_api_key", json={"api_key": "sk-firstkey0000"}, headers=headers)
    resp = await client.put("/api/v1/integrations/openai_api_key", json={"api_key": "sk-secondkey1111"}, headers=headers)
    assert resp.status_code == 200
    assert resp.json()["last_four"] == "1111"

    resp = await client.get("/api/v1/integrations/openai_api_key", headers=headers)
    assert resp.json()["last_four"] == "1111"


@pytest.mark.asyncio
async def test_invalid_key_format_rejected(client: AsyncClient):
    data = await register_and_get_token(client, "byok-invalid")
    headers = {"Authorization": f"Bearer {data['access_token']}"}

    resp = await client.put("/api/v1/integrations/openai_api_key", json={"api_key": "not-a-real-key"}, headers=headers)
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_unknown_integration_type_404(client: AsyncClient):
    data = await register_and_get_token(client, "byok-unknown")
    headers = {"Authorization": f"Bearer {data['access_token']}"}

    resp = await client.put("/api/v1/integrations/slack_oauth", json={"api_key": "sk-whatever0000"}, headers=headers)
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_cross_tenant_integration_isolation(client: AsyncClient):
    org_a = await register_and_get_token(client, "byok-a")
    org_b = await register_and_get_token(client, "byok-b")
    headers_a = {"Authorization": f"Bearer {org_a['access_token']}"}
    headers_b = {"Authorization": f"Bearer {org_b['access_token']}"}

    resp = await client.put("/api/v1/integrations/openai_api_key", json={"api_key": "sk-orgasecret0"}, headers=headers_a)
    assert resp.status_code == 200

    # Org B sees no key of its own, not Org A's.
    resp = await client.get("/api/v1/integrations/openai_api_key", headers=headers_b)
    assert resp.status_code == 404

    # Org B deleting has no effect on Org A's stored key.
    resp = await client.delete("/api/v1/integrations/openai_api_key", headers=headers_b)
    assert resp.status_code == 404

    resp = await client.get("/api/v1/integrations/openai_api_key", headers=headers_a)
    assert resp.status_code == 200
    assert resp.json()["last_four"] == "sk-orgasecret0"[-4:]


# ---------------------------------------------------------------------------
# Integration — execution-path wiring (the actual seam)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stored_org_key_overrides_settings_fallback(client: AsyncClient, monkeypatch):
    """
    An org with a stored BYOK key must have its agent nodes call OpenAI with
    that key, not the platform-wide settings.OPENAI_API_KEY — the whole point
    of BYOK.
    """
    monkeypatch.setattr("src.core.llm_client.settings.OPENAI_API_KEY", "sk-platform-fallback")

    ctx = await _publish_agent_workflow(client, "byok-wired", AGENT_CONFIG)
    headers = ctx["headers"]

    put_resp = await client.put("/api/v1/integrations/openai_api_key", json={"api_key": "sk-orgs-own-key99"}, headers=headers)
    assert put_resp.status_code == 200

    resp = await client.post(
        f"/api/v1/workflows/{ctx['workflow_id']}/run",
        json={"trigger_payload": {"document": "invoice.pdf"}},
        headers=headers,
    )
    assert resp.status_code == 201
    run_data = resp.json()
    run_id = uuid.UUID(run_data["id"])
    org_id = uuid.UUID(run_data["organization_id"])

    version = await _load_version(ctx["version_id"])
    from src.graphs.compiler import initial_state_from_trigger

    initial_state = initial_state_from_trigger(organization_id=org_id, trigger_payload={"document": "invoice.pdf"}, run_id=str(run_id))

    mock, mock_openai = _patched_openai(EXTRACTION)
    try:
        await _stream_graph(run_id, version, initial_state, attempt=1, organization_id=org_id)
    finally:
        mock.stop()

    assert mock_openai.call_args.kwargs["api_key"] == "sk-orgs-own-key99"


@pytest.mark.asyncio
async def test_no_stored_key_falls_back_to_settings(client: AsyncClient, monkeypatch):
    """Without a stored integration, execution behaves exactly as before BYOK existed."""
    monkeypatch.setattr("src.core.llm_client.settings.OPENAI_API_KEY", "sk-platform-fallback")

    ctx = await _publish_agent_workflow(client, "byok-fallback", AGENT_CONFIG)
    headers = ctx["headers"]

    resp = await client.post(
        f"/api/v1/workflows/{ctx['workflow_id']}/run",
        json={"trigger_payload": {"document": "invoice.pdf"}},
        headers=headers,
    )
    run_data = resp.json()
    run_id = uuid.UUID(run_data["id"])
    org_id = uuid.UUID(run_data["organization_id"])

    version = await _load_version(ctx["version_id"])
    from src.graphs.compiler import initial_state_from_trigger

    initial_state = initial_state_from_trigger(organization_id=org_id, trigger_payload={"document": "invoice.pdf"}, run_id=str(run_id))

    mock, mock_openai = _patched_openai(EXTRACTION)
    try:
        await _stream_graph(run_id, version, initial_state, attempt=1, organization_id=org_id)
    finally:
        mock.stop()

    assert mock_openai.call_args.kwargs["api_key"] == "sk-platform-fallback"
