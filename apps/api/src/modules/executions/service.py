"""
modules/executions/service.py — Business logic for workflow execution.

Layering: service calls repository; routers call service only.
organization_id always comes from the authenticated JWT context — never a
request body.

Business rules enforced here:
1. A run can only be created against a workflow with a published version
   (current_version_id IS NOT NULL). Attempting to run an unpublished
   workflow raises HTTP 422.
2. A run can only be resumed when its status is waiting_approval.
3. Approved resumes enqueue a Celery task; rejected resumes are resolved
   here immediately (no graph execution — the run is terminal).
4. FUTURE: per-node approver assignment is not implemented here.
   Any org member with execution:approve can resume any waiting run in the org.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import secrets
import uuid
from datetime import UTC, datetime
from typing import Any

from cryptography.exceptions import InvalidTag
from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.cache import RunQuotaExceeded, consume_run_quota
from src.core.encryption import decrypt_secret
from src.core.redis import get_redis_client
from src.modules.audit_logs.schemas import AuditContext
from src.modules.audit_logs.service import AuditAction, AuditService
from src.modules.executions.repository import ExecutionRepository
from src.modules.executions.schemas import (
    ResumeRequest,
    RunTriggerRequest,
    WorkflowRunResponse,
    WorkflowRunSummary,
)
from src.modules.workflows.repository import WorkflowRepository

logger = logging.getLogger(__name__)

#: How far a signed request's timestamp may be from server time before it is
#: rejected as a replay. Five minutes is the Stripe/GitHub convention — wide
#: enough for ordinary clock skew, narrow enough that a captured request has a
#: short useful life.
WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300


def verify_webhook_signature(
    *,
    secret: str | None,
    raw_body: bytes,
    signature_header: str | None,
    timestamp_header: str | None,
) -> bool:
    """
    Verify `X-AAP-Signature: sha256=<hex>` over `"{timestamp}.{raw_body}"`.

    Returns a plain bool — the caller converts every failure into one identical
    401, so this deliberately does not report *which* check failed.

    Three properties worth not regressing:

    - **The timestamp is inside the signed material.** Signing the body alone
      would let an attacker replay a captured request forever; binding the
      timestamp means changing it invalidates the signature, so the freshness
      window is actually enforced rather than advisory.
    - **`raw_body`, not the parsed JSON.** Re-serializing parsed JSON changes
      key order and whitespace, so the bytes signed by the caller and the bytes
      hashed here would differ. This is why the router reads `await
      request.body()` instead of taking a Pydantic model.
    - **`hmac.compare_digest`, never `==`.** Byte-by-byte comparison leaks the
      correct prefix through timing.

    A None secret (no such workflow, wrong trigger type, or none generated yet)
    still runs the full HMAC against a random throwaway key so the miss costs
    the same wall-clock time as a mismatch.
    """
    if not signature_header or not timestamp_header:
        return False

    try:
        signed_at = int(timestamp_header)
    except ValueError:
        return False

    now = int(datetime.now(UTC).timestamp())
    if abs(now - signed_at) > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS:
        return False

    # Never let a missing secret short-circuit — burn the same work.
    key = (secret or secrets.token_urlsafe(32)).encode("utf-8")
    expected = hmac.new(key, f"{signed_at}.".encode() + raw_body, hashlib.sha256).hexdigest()

    provided = signature_header[len("sha256=") :] if signature_header.startswith("sha256=") else signature_header
    ok = hmac.compare_digest(expected, provided.strip())
    return ok and secret is not None


def _parse_webhook_payload(raw_body: bytes) -> dict[str, Any]:
    """
    Decode the signed body into the run's trigger_payload.

    Parsed only AFTER the signature verifies — an unauthenticated caller must
    never reach the JSON parser. A non-object or unparseable body is wrapped
    rather than rejected: the signature already proved the sender is authorized,
    and failing an authorized run on a content-type technicality is worse than
    handing the graph a `{"_raw": ...}` it can inspect.
    """
    if not raw_body:
        return {}
    try:
        parsed = json.loads(raw_body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return {"_raw": raw_body.decode("utf-8", errors="replace")}
    if isinstance(parsed, dict):
        return parsed
    return {"_raw": parsed}


class ExecutionService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self._repo = ExecutionRepository(db)
        self._wf_repo = WorkflowRepository(db)
        self._audit = AuditService(db)

    async def _claim_run_quota(self, organization_id: uuid.UUID) -> None:
        """
        Consume one unit of the org's daily run allowance, or raise 429.

        Called on both HTTP trigger paths BEFORE the run row is created, so an
        over-quota request never leaves a `pending` run that nothing will ever
        execute. The schedule tick claims its own quota separately (it cannot
        raise HTTP) — see workers/trigger_tasks.py.

        Note this is NOT called on resume: approving a waiting run continues a
        run that was already counted at trigger time, and charging it twice
        would make an approval-heavy workflow cost double its quota.
        """
        try:
            await consume_run_quota(await get_redis_client(), str(organization_id))
        except RunQuotaExceeded as exc:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=(f"Daily workflow-run quota of {exc.limit} reached for this organization. Resets at 00:00 UTC."),
                headers={"Retry-After": str(exc.retry_after_seconds)},
            ) from exc

    async def trigger_run(
        self,
        organization_id: uuid.UUID,
        workflow_id: uuid.UUID,
        body: RunTriggerRequest,
        context: AuditContext | None = None,
    ) -> WorkflowRunResponse:
        """
        Create a WorkflowRun pinned to the workflow's current published version,
        then enqueue the execute_workflow Celery task.
        """
        # Verify the workflow belongs to this org and has a published version.
        workflow = await self._wf_repo.get_by_id(organization_id, workflow_id)
        if workflow is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workflow not found")

        if workflow.current_version_id is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Workflow has no published version. Publish a version before triggering a run.",
            )

        await self._claim_run_quota(organization_id)

        run = await self._repo.create_run(
            organization_id=organization_id,
            workflow_version_id=workflow.current_version_id,
            trigger_payload=body.trigger_payload,
        )
        await self._audit.record(
            organization_id=organization_id,
            context=context or AuditContext.system(),
            action=AuditAction.WORKFLOW_RUN_STARTED,
            resource_type="workflow_run",
            resource_id=run.id,
            metadata={"workflow_id": str(workflow_id), "trigger": "manual"},
        )
        await self.db.commit()
        await self.db.refresh(run)

        # Import here to avoid circular import at module level
        from src.workers.graph_tasks import execute_workflow

        execute_workflow.delay(str(run.id))

        # Re-fetch with node_executions (empty at this point but consistent shape)
        run = await self._repo.get_run(organization_id, run.id)
        return WorkflowRunResponse.model_validate(run)

    async def trigger_from_webhook(
        self,
        workflow_id: uuid.UUID,
        *,
        raw_body: bytes,
        signature_header: str | None,
        timestamp_header: str | None,
    ) -> WorkflowRunResponse:
        """
        Create and enqueue a run from an UNAUTHENTICATED inbound webhook.

        There is no JWT on this request. Authorization is the HMAC signature, and
        `organization_id` is read off the workflow row — never from the caller.

        Every rejection below returns the SAME 401 with the same detail string.
        That uniformity is deliberate: distinguishing "no such workflow" from
        "bad signature" would turn this endpoint into an oracle for enumerating
        which workflow UUIDs exist, across every tenant, with no credentials.
        The only non-401 rejection is the 422 for an unpublished workflow, which
        is reachable only by a caller who already proved possession of the
        secret.
        """
        workflow = await self._wf_repo.get_by_id_unscoped(workflow_id)

        # Constant-ish: still verify a dummy signature when the workflow is
        # missing or unconfigured so the failure path doesn't return measurably
        # faster than a genuine signature mismatch.
        stored_secret: str | None = None
        if workflow is not None and workflow.trigger_type == "webhook" and workflow.webhook_secret_encrypted:
            try:
                stored_secret = decrypt_secret(workflow.webhook_secret_encrypted)
            except InvalidTag:
                # Ciphertext no longer decrypts — INTEGRATION_ENCRYPTION_KEY was
                # rotated without re-encrypting. Log loudly; the caller still
                # gets the uniform 401.
                logger.error(
                    "Webhook secret for workflow=%s failed to decrypt — INTEGRATION_ENCRYPTION_KEY may have been rotated.",
                    workflow_id,
                )

        if not verify_webhook_signature(
            secret=stored_secret,
            raw_body=raw_body,
            signature_header=signature_header,
            timestamp_header=timestamp_header,
        ):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or missing webhook signature.",
            )

        assert workflow is not None  # implied by a passing signature — a null secret never verifies

        if workflow.current_version_id is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Workflow has no published version. Publish a version before triggering a run.",
            )

        # Quota is claimed only AFTER the signature verifies. Claiming it first
        # would let an unauthenticated attacker burn a tenant's entire daily
        # allowance with forged requests — a denial-of-service on the org's
        # ability to run anything, from outside, with no credentials.
        await self._claim_run_quota(workflow.organization_id)

        payload = _parse_webhook_payload(raw_body)

        run = await self._repo.create_run(
            organization_id=workflow.organization_id,
            workflow_version_id=workflow.current_version_id,
            trigger_payload=payload,
        )
        # actor_type='system': the request authenticated by HMAC, not as a user.
        # The sender's IP is deliberately not recorded as an actor IP — it
        # belongs to an external caller, not to a member of this org.
        await self._audit.record(
            organization_id=workflow.organization_id,
            context=AuditContext.system(),
            action=AuditAction.WORKFLOW_RUN_STARTED,
            resource_type="workflow_run",
            resource_id=run.id,
            metadata={"workflow_id": str(workflow_id), "trigger": "webhook"},
        )
        # A webhook does not advance next_run_at — that column belongs to the
        # schedule path alone. Preserve whatever is there.
        await self._wf_repo.mark_triggered(workflow_id, next_run_at=workflow.next_run_at)
        await self.db.commit()
        await self.db.refresh(run)

        from src.workers.graph_tasks import execute_workflow

        execute_workflow.delay(str(run.id))

        run = await self._repo.get_run(workflow.organization_id, run.id)
        return WorkflowRunResponse.model_validate(run)

    async def list_runs(
        self,
        organization_id: uuid.UUID,
        workflow_id: uuid.UUID | None = None,
        status_filter: str | None = None,
        cursor: str | None = None,
        limit: int = 50,
    ) -> list[WorkflowRunSummary]:
        """
        List the org's runs, newest first. `status_filter` is named to avoid
        shadowing fastapi.status at the router, same as WorkflowService.list_workflows.
        """
        rows = await self._repo.list_runs(
            organization_id,
            workflow_id=workflow_id,
            status=status_filter,
            cursor=cursor,
            limit=limit,
        )
        return [
            WorkflowRunSummary(
                id=run.id,
                workflow_id=wf_id,
                workflow_name=wf_name,
                workflow_version_id=run.workflow_version_id,
                version_number=version_number,
                status=run.status,
                started_at=run.started_at,
                completed_at=run.completed_at,
                total_cost_usd=float(run.total_cost_usd) if run.total_cost_usd is not None else None,
                created_at=run.created_at,
            )
            for run, wf_id, wf_name, version_number in rows
        ]

    async def get_run(
        self,
        organization_id: uuid.UUID,
        run_id: uuid.UUID,
    ) -> WorkflowRunResponse:
        run = await self._repo.get_run(organization_id, run_id)
        if run is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Execution not found")
        return WorkflowRunResponse.model_validate(run)

    async def resume_run(
        self,
        organization_id: uuid.UUID,
        run_id: uuid.UUID,
        body: ResumeRequest,
        context: AuditContext | None = None,
    ) -> WorkflowRunResponse:
        """
        Resume or reject a waiting_approval run.

        Approved: transitions to running, enqueues resume_workflow task.
        Rejected: transitions directly to rejected (terminal) — no graph execution.

        Both outcomes are audited. This is the single most compliance-relevant
        pair of actions in the product — a human authorizing (or refusing) a
        mutating ERP write — so the row records who decided, from where, and
        their comment. No run quota is claimed here: the run was counted when it
        was triggered.
        """
        run = await self._repo.get_run(organization_id, run_id)
        if run is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Execution not found")

        if run.status != "waiting_approval":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Run cannot be resumed from status '{run.status}'. Expected 'waiting_approval'.",
            )

        await self._audit.record(
            organization_id=organization_id,
            context=context or AuditContext.system(),
            action=(AuditAction.APPROVAL_REJECTED if body.decision == "rejected" else AuditAction.APPROVAL_APPROVED),
            resource_type="workflow_run",
            resource_id=run_id,
            metadata={
                "decision": body.decision,
                "comment": body.comment,
                "node_key": run.current_node_key,
            },
        )

        if body.decision == "rejected":
            # Terminal — mark rejected immediately, no Celery task needed.
            await self._repo.update_run_status(
                organization_id,
                run_id,
                "rejected",
                completed_at=datetime.now(UTC),
                interrupt_payload=None,
                error={"message": "Rejected by approver", "comment": body.comment},
            )
            await self.db.commit()
        else:
            # Approved — hand off to the worker to continue graph execution.
            await self._repo.update_run_status(
                organization_id,
                run_id,
                "running",
                interrupt_payload=None,
            )
            await self.db.commit()

            from src.workers.graph_tasks import resume_workflow

            resume_payload: dict[str, Any] = {"decision": "approved"}
            if body.comment:
                resume_payload["comment"] = body.comment
            resume_workflow.delay(str(run_id), resume_payload)

        run = await self._repo.get_run(organization_id, run_id)
        return WorkflowRunResponse.model_validate(run)
