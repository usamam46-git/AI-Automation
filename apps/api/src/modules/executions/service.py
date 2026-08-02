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

import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.modules.executions.repository import ExecutionRepository
from src.modules.executions.schemas import ResumeRequest, RunTriggerRequest, WorkflowRunResponse
from src.modules.workflows.repository import WorkflowRepository


class ExecutionService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self._repo = ExecutionRepository(db)
        self._wf_repo = WorkflowRepository(db)

    async def trigger_run(
        self,
        organization_id: uuid.UUID,
        workflow_id: uuid.UUID,
        body: RunTriggerRequest,
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

        run = await self._repo.create_run(
            organization_id=organization_id,
            workflow_version_id=workflow.current_version_id,
            trigger_payload=body.trigger_payload,
        )
        await self.db.commit()
        await self.db.refresh(run)

        # Import here to avoid circular import at module level
        from src.workers.graph_tasks import execute_workflow

        execute_workflow.delay(str(run.id))

        # Re-fetch with node_executions (empty at this point but consistent shape)
        run = await self._repo.get_run(organization_id, run.id)
        return WorkflowRunResponse.model_validate(run)

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
    ) -> WorkflowRunResponse:
        """
        Resume or reject a waiting_approval run.

        Approved: transitions to running, enqueues resume_workflow task.
        Rejected: transitions directly to rejected (terminal) — no graph execution.
        """
        run = await self._repo.get_run(organization_id, run_id)
        if run is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Execution not found")

        if run.status != "waiting_approval":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Run cannot be resumed from status '{run.status}'. Expected 'waiting_approval'.",
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
