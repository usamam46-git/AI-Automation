"""
tests/test_trigger_webhook.py — inbound HMAC-signed webhook triggers.

POST /api/v1/triggers/workflows/{workflow_id} is the only unauthenticated route
in the application, so most of this file is about what it REFUSES to do:

  - reject every malformed/forged/stale signature with one indistinguishable
    401, so it cannot be used to enumerate workflow UUIDs across tenants;
  - never accept an organization_id from the caller — it is read off the
    workflow row the signature authenticated against;
  - never return the signing secret from any read endpoint, only once at
    generation.
"""

import hashlib
import hmac
import json
import uuid
from datetime import UTC, datetime

from httpx import AsyncClient
from sqlalchemy import select

from src.db.database import async_session_maker
from src.modules.executions.models import WorkflowRun
from src.modules.executions.service import verify_webhook_signature
from src.modules.workflows.models import Workflow

UNIFORM_401_DETAIL = "Invalid or missing webhook signature."


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _sign(secret: str, body: bytes, *, timestamp: int | None = None) -> dict[str, str]:
    ts = timestamp if timestamp is not None else int(datetime.now(UTC).timestamp())
    digest = hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    return {
        "X-AAP-Signature": f"sha256={digest}",
        "X-AAP-Timestamp": str(ts),
        "Content-Type": "application/json",
    }


async def _webhook_workflow(client: AsyncClient, tag: str) -> dict:
    """Publish a runnable graph, switch it to a webhook trigger, mint a secret."""
    from test_executions import _register_and_publish

    ctx = await _register_and_publish(client, f"wh-{tag}")

    patched = await client.patch(
        f"/api/v1/workflows/{ctx['workflow_id']}",
        json={"trigger_type": "webhook"},
        headers=ctx["headers"],
    )
    assert patched.status_code == 200, patched.text

    minted = await client.post(
        f"/api/v1/workflows/{ctx['workflow_id']}/webhook-secret",
        headers=ctx["headers"],
    )
    assert minted.status_code == 201, minted.text
    ctx["secret"] = minted.json()["secret"]
    ctx["endpoint"] = minted.json()["endpoint_path"]
    return ctx


async def _runs_for(version_id: str) -> list[WorkflowRun]:
    async with async_session_maker() as session:
        result = await session.execute(select(WorkflowRun).where(WorkflowRun.workflow_version_id == uuid.UUID(version_id)))
        return list(result.scalars().all())


# ---------------------------------------------------------------------------
# Signature verification — pure unit tests
# ---------------------------------------------------------------------------


def test_valid_signature_verifies():
    body = b'{"invoice_id":"INV-1"}'
    headers = _sign("whsec_test", body)
    assert verify_webhook_signature(
        secret="whsec_test",
        raw_body=body,
        signature_header=headers["X-AAP-Signature"],
        timestamp_header=headers["X-AAP-Timestamp"],
    )


def test_body_tampering_invalidates_the_signature():
    body = b'{"amount":100}'
    headers = _sign("whsec_test", body)
    assert not verify_webhook_signature(
        secret="whsec_test",
        raw_body=b'{"amount":999999}',
        signature_header=headers["X-AAP-Signature"],
        timestamp_header=headers["X-AAP-Timestamp"],
    )


def test_timestamp_is_bound_into_the_signature():
    """
    Replay defence only works if the timestamp is signed. Reusing a captured
    signature with a fresher timestamp must fail — otherwise the freshness
    window is decorative and any captured request replays forever.
    """
    body = b'{"x":1}'
    old = int(datetime.now(UTC).timestamp()) - 1000
    headers = _sign("whsec_test", body, timestamp=old)

    assert not verify_webhook_signature(
        secret="whsec_test",
        raw_body=body,
        signature_header=headers["X-AAP-Signature"],
        timestamp_header=str(int(datetime.now(UTC).timestamp())),
    )


def test_stale_timestamp_rejected_even_when_correctly_signed():
    body = b'{"x":1}'
    stale = int(datetime.now(UTC).timestamp()) - 400  # > 300s tolerance
    headers = _sign("whsec_test", body, timestamp=stale)

    assert not verify_webhook_signature(
        secret="whsec_test",
        raw_body=body,
        signature_header=headers["X-AAP-Signature"],
        timestamp_header=headers["X-AAP-Timestamp"],
    )


def test_none_secret_never_verifies():
    """
    A workflow with no secret set must not be triggerable by ANY signature,
    including one computed over a null/empty key.
    """
    body = b"{}"
    for candidate_key in ["", "None", "null"]:
        ts = int(datetime.now(UTC).timestamp())
        digest = hmac.new(candidate_key.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
        assert not verify_webhook_signature(
            secret=None,
            raw_body=body,
            signature_header=f"sha256={digest}",
            timestamp_header=str(ts),
        )


def test_missing_headers_rejected():
    assert not verify_webhook_signature(secret="s", raw_body=b"{}", signature_header=None, timestamp_header="1")
    assert not verify_webhook_signature(secret="s", raw_body=b"{}", signature_header="sha256=x", timestamp_header=None)
    assert not verify_webhook_signature(secret="s", raw_body=b"{}", signature_header="sha256=x", timestamp_header="not-a-number")


def test_bare_hex_signature_accepted_without_the_sha256_prefix():
    """Tolerated for callers whose HTTP client strips or mangles the prefix."""
    body = b'{"x":1}'
    ts = int(datetime.now(UTC).timestamp())
    digest = hmac.new(b"whsec_test", f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    assert verify_webhook_signature(secret="whsec_test", raw_body=body, signature_header=digest, timestamp_header=str(ts))


# ---------------------------------------------------------------------------
# Endpoint — happy path
# ---------------------------------------------------------------------------


async def test_signed_webhook_creates_a_run(client: AsyncClient, celery_calls):
    ctx = await _webhook_workflow(client, "happy")
    body = json.dumps({"invoice_id": "INV-2231", "amount": 4200}).encode()

    resp = await client.post(ctx["endpoint"], content=body, headers=_sign(ctx["secret"], body))

    assert resp.status_code == 202, resp.text
    runs = await _runs_for(ctx["version_id"])
    assert len(runs) == 1
    assert runs[0].trigger_payload == {"invoice_id": "INV-2231", "amount": 4200}
    assert [c[0] for c in celery_calls] == ["execute_workflow"]


async def test_run_org_comes_from_the_workflow_row(client: AsyncClient):
    """
    No JWT means no authenticated org. The invariant still holds: the run's
    organization_id is read off the workflow, never supplied — including when
    the caller actively tries to inject one in the body.
    """
    ctx = await _webhook_workflow(client, "org")
    forged_org = str(uuid.uuid4())
    body = json.dumps({"organization_id": forged_org}).encode()

    resp = await client.post(ctx["endpoint"], content=body, headers=_sign(ctx["secret"], body))
    assert resp.status_code == 202, resp.text

    async with async_session_maker() as session:
        workflow = (await session.execute(select(Workflow).where(Workflow.id == uuid.UUID(ctx["workflow_id"])))).scalar_one()

    run = (await _runs_for(ctx["version_id"]))[0]
    assert run.organization_id == workflow.organization_id
    assert str(run.organization_id) != forged_org


async def test_webhook_updates_last_triggered_at(client: AsyncClient):
    ctx = await _webhook_workflow(client, "stamp")
    body = b"{}"
    resp = await client.post(ctx["endpoint"], content=body, headers=_sign(ctx["secret"], body))
    assert resp.status_code == 202

    async with async_session_maker() as session:
        workflow = (await session.execute(select(Workflow).where(Workflow.id == uuid.UUID(ctx["workflow_id"])))).scalar_one()
    assert workflow.last_triggered_at is not None


async def test_non_json_body_is_wrapped_not_rejected(client: AsyncClient):
    """
    The signature already proved the sender is authorized. Failing an authorized
    run on a content-type technicality is worse than handing the graph a _raw
    payload it can inspect.
    """
    ctx = await _webhook_workflow(client, "raw")
    body = b"plain text, not json"

    resp = await client.post(ctx["endpoint"], content=body, headers=_sign(ctx["secret"], body))
    assert resp.status_code == 202, resp.text

    run = (await _runs_for(ctx["version_id"]))[0]
    assert run.trigger_payload == {"_raw": "plain text, not json"}


# ---------------------------------------------------------------------------
# Endpoint — rejection paths, all indistinguishable
# ---------------------------------------------------------------------------


async def test_forged_signature_rejected(client: AsyncClient, celery_calls):
    ctx = await _webhook_workflow(client, "forged")
    body = b'{"amount":1}'
    headers = _sign("whsec_attacker_guess", body)

    resp = await client.post(ctx["endpoint"], content=body, headers=headers)

    assert resp.status_code == 401
    assert resp.json()["detail"] == UNIFORM_401_DETAIL
    assert await _runs_for(ctx["version_id"]) == []
    assert celery_calls == []


async def test_unsigned_request_rejected(client: AsyncClient):
    ctx = await _webhook_workflow(client, "unsigned")
    resp = await client.post(ctx["endpoint"], content=b"{}", headers={"Content-Type": "application/json"})
    assert resp.status_code == 401
    assert resp.json()["detail"] == UNIFORM_401_DETAIL


async def test_replayed_stale_request_rejected(client: AsyncClient):
    ctx = await _webhook_workflow(client, "replay")
    body = b'{"x":1}'
    stale = int(datetime.now(UTC).timestamp()) - 400

    resp = await client.post(ctx["endpoint"], content=body, headers=_sign(ctx["secret"], body, timestamp=stale))
    assert resp.status_code == 401
    assert await _runs_for(ctx["version_id"]) == []


async def test_unknown_workflow_is_indistinguishable_from_a_bad_signature(client: AsyncClient):
    """
    The anti-enumeration property. A nonexistent workflow UUID and a real one
    with a wrong signature must produce byte-identical responses — otherwise an
    unauthenticated caller can probe which workflow IDs exist in any tenant.
    """
    ctx = await _webhook_workflow(client, "enum")
    body = b"{}"
    headers = _sign("whsec_wrong", body)

    real = await client.post(ctx["endpoint"], content=body, headers=headers)
    ghost = await client.post(f"/api/v1/triggers/workflows/{uuid.uuid4()}", content=body, headers=headers)

    assert real.status_code == ghost.status_code == 401
    assert real.json() == ghost.json()


async def test_manual_workflow_cannot_be_webhook_triggered(client: AsyncClient):
    """
    A workflow whose trigger_type is not 'webhook' has no secret loaded, so no
    signature can verify — and the refusal looks like every other 401.
    """
    from test_executions import _register_and_publish

    ctx = await _register_and_publish(client, "wh-manual")
    body = b"{}"

    resp = await client.post(
        f"/api/v1/triggers/workflows/{ctx['workflow_id']}",
        content=body,
        headers=_sign("whsec_anything", body),
    )
    assert resp.status_code == 401
    assert resp.json()["detail"] == UNIFORM_401_DETAIL


async def test_unpublished_webhook_workflow_returns_422_after_a_valid_signature(client: AsyncClient):
    """
    The one non-401 rejection, reachable only by a caller who already proved
    possession of the secret — so it leaks nothing to an anonymous prober.
    """
    from test_workflow_versions import create_workspace, register_and_get_token

    data = await register_and_get_token(client, "wh-unpub")
    token = data["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    ws = await create_workspace(client, token)

    created = await client.post(
        "/api/v1/workflows",
        json={"name": "Unpublished Hook", "workspace_id": ws["id"], "trigger_type": "webhook"},
        headers=headers,
    )
    workflow_id = created.json()["id"]
    minted = await client.post(f"/api/v1/workflows/{workflow_id}/webhook-secret", headers=headers)
    secret = minted.json()["secret"]

    body = b"{}"
    resp = await client.post(f"/api/v1/triggers/workflows/{workflow_id}", content=body, headers=_sign(secret, body))
    assert resp.status_code == 422
    assert "no published version" in resp.text


# ---------------------------------------------------------------------------
# Secret lifecycle
# ---------------------------------------------------------------------------


async def test_secret_is_never_returned_by_any_read_endpoint(client: AsyncClient):
    ctx = await _webhook_workflow(client, "leak")

    detail = await client.get(f"/api/v1/workflows/{ctx['workflow_id']}", headers=ctx["headers"])
    listed = await client.get("/api/v1/workflows", headers=ctx["headers"])

    assert detail.status_code == 200
    assert ctx["secret"] not in detail.text
    assert ctx["secret"] not in listed.text
    # Presence is advertised as a bare bool — no prefix, no last_four. Every
    # leaked byte of an HMAC key shortens a brute-force.
    assert detail.json()["has_webhook_secret"] is True
    assert "webhook_secret_encrypted" not in detail.text


async def test_secret_is_stored_encrypted_not_plaintext(client: AsyncClient):
    ctx = await _webhook_workflow(client, "atrest")

    async with async_session_maker() as session:
        workflow = (await session.execute(select(Workflow).where(Workflow.id == uuid.UUID(ctx["workflow_id"])))).scalar_one()

    blob = workflow.webhook_secret_encrypted
    assert blob is not None
    assert ctx["secret"].encode() not in blob

    from src.core.encryption import decrypt_secret

    assert decrypt_secret(blob) == ctx["secret"]


async def test_rotation_invalidates_the_previous_secret(client: AsyncClient):
    ctx = await _webhook_workflow(client, "rotate")
    old_secret = ctx["secret"]

    rotated = await client.post(f"/api/v1/workflows/{ctx['workflow_id']}/webhook-secret", headers=ctx["headers"])
    assert rotated.status_code == 201
    new_secret = rotated.json()["secret"]
    assert new_secret != old_secret

    body = b"{}"
    stale = await client.post(ctx["endpoint"], content=body, headers=_sign(old_secret, body))
    fresh = await client.post(ctx["endpoint"], content=body, headers=_sign(new_secret, body))

    assert stale.status_code == 401
    assert fresh.status_code == 202


async def test_secret_cannot_be_minted_for_a_non_webhook_workflow(client: AsyncClient):
    from test_executions import _register_and_publish

    ctx = await _register_and_publish(client, "wh-wrongtype")
    resp = await client.post(f"/api/v1/workflows/{ctx['workflow_id']}/webhook-secret", headers=ctx["headers"])
    assert resp.status_code == 422
    assert "not 'webhook'" in resp.text


async def test_cross_tenant_secret_minting_is_404(client: AsyncClient):
    """Org A must not be able to mint (or rotate) a secret on Org B's workflow."""
    ctx_a = await _webhook_workflow(client, "tenant-a")
    ctx_b = await _webhook_workflow(client, "tenant-b")

    resp = await client.post(f"/api/v1/workflows/{ctx_b['workflow_id']}/webhook-secret", headers=ctx_a["headers"])
    assert resp.status_code == 404, resp.text

    # And B's original secret still works — A's attempt rotated nothing.
    body = b"{}"
    assert (await client.post(ctx_b["endpoint"], content=body, headers=_sign(ctx_b["secret"], body))).status_code == 202
