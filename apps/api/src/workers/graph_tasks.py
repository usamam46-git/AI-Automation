"""
workers/graph_tasks.py — Celery tasks for LangGraph workflow execution.

Architecture note (deliberate simplification per implementation Decision 5):
  A single Celery task holds the entire run via compiled.astream() until the
  graph reaches an interrupt or terminal state. Vol. 2 §5.2 describes a more
  resilient re-enqueue-per-node architecture as a future optimization; it is
  NOT implemented here. The tradeoff: a worker crash mid-run loses work since
  the last checkpoint write, but the checkpoint itself is durable in Postgres,
  so the run can be manually re-triggered from the last saved checkpoint.
  This matches Vol. 6 §9's stated RPO for this phase.

Error handling:
  - NodeNotImplementedError, DraftVersionCompileError, GraphCompileError,
    and the node-level config/exhausted-retry errors in _NON_RETRYABLE:
    non-retryable — mark run failed immediately.
  - All other exceptions: retried up to 3 times with exponential backoff,
    then dead-lettered with run marked failed.

Idempotency:
  At task start the run's status is checked. If it is not pending/running,
  another task already completed or failed it — skip execution. This prevents
  double-execution from accidental duplicate enqueues.
"""

from __future__ import annotations

import asyncio
import functools
import logging
import time
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from celery import Task
from celery.exceptions import MaxRetriesExceededError
from langgraph.types import Command
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from src.core.llm_client import LLMClient, LLMConfigurationError, LLMTransientError, get_llm_client
from src.db.database import async_session_maker
from src.graphs.compiler import (
    DraftVersionCompileError,
    GraphCompileError,
    _compile_state_graph,
    initial_state_from_trigger,
)
from src.graphs.node_handlers import (
    AgentNodeConfigError,
    NodeNotImplementedError,
    ToolAuthenticationError,
    ToolExecutionError,
    ToolNodeConfigError,
)
from src.modules.executions.models import NodeExecution, WorkflowRun
from src.modules.integrations.service import IntegrationService
from src.modules.workflows.models import WorkflowVersion
from src.workers.celery_app import celery_app
from src.workers.postgres_saver import PostgresSaver

logger = logging.getLogger(__name__)

# Errors that indicate a structural problem with the graph — never retry.
#
# LLMTransientError belongs here despite being transient in origin: LLMClient has
# already retried it 3x with backoff (Vol. 2 §14 — "up to 3 attempts, then node
# marked failed"). Retrying again at the Celery layer would compound to 12 API
# calls and 12x the cost for one node.
#
# ToolExecutionError is here for exactly the same reason — tool_handler already
# retried the outbound call 3x — and this matters more for tools than for LLM calls:
# a mutating tool node (an ERP write, a payment) re-driven by a Celery retry could
# post the same journal entry four times.
_NON_RETRYABLE = (
    NodeNotImplementedError,
    AgentNodeConfigError,
    DraftVersionCompileError,
    GraphCompileError,
    LLMConfigurationError,
    LLMTransientError,
    ToolNodeConfigError,
    ToolExecutionError,
    ToolAuthenticationError,
)


# ---------------------------------------------------------------------------
# Shared async helpers (used by both tasks)
# ---------------------------------------------------------------------------


async def _load_run_with_version(run_id: uuid.UUID) -> tuple[WorkflowRun, WorkflowVersion] | None:
    """
    Load WorkflowRun + its pinned WorkflowVersion (with nodes/edges).
    Returns None if the run doesn't exist.
    """
    async with async_session_maker() as session:
        stmt = (
            select(WorkflowRun)
            .where(WorkflowRun.id == run_id)
            .options(
                selectinload(WorkflowRun.workflow_version).options(
                    selectinload(WorkflowVersion.nodes),
                    selectinload(WorkflowVersion.edges),
                )
            )
        )
        result = await session.execute(stmt)
        run = result.scalar_one_or_none()
        if run is None:
            return None
        version = run.workflow_version
    return run, version


async def _update_run(run_id: uuid.UUID, **kwargs: Any) -> None:
    from sqlalchemy import update as sa_update

    async with async_session_maker() as session:
        await session.execute(sa_update(WorkflowRun).where(WorkflowRun.id == run_id).values(**kwargs))
        await session.commit()


async def _insert_node_execution(
    *,
    workflow_run_id: uuid.UUID,
    node_key: str,
    status: str,
    input_snapshot: dict[str, Any] | None,
    output_snapshot: dict[str, Any] | None,
    latency_ms: int,
    attempt: int,
    tokens_prompt: int | None = None,
    tokens_completion: int | None = None,
    cost_usd: float | None = None,
) -> bool:
    """
    Insert a NodeExecution row after checking idempotency.
    Returns False and skips insert if a succeeded row already exists for
    (workflow_run_id, node_key, attempt) — guards against duplicate writes
    on Celery retry.

    The token/cost arguments stay optional because non-LLM nodes (start, end,
    human_approval gates) have no usage to report and leave those columns NULL.
    """
    async with async_session_maker() as session:
        existing_stmt = select(NodeExecution).where(
            NodeExecution.workflow_run_id == workflow_run_id,
            NodeExecution.node_key == node_key,
            NodeExecution.attempt == attempt,
            NodeExecution.status == "succeeded",
        )
        existing = await session.execute(existing_stmt)
        if existing.scalar_one_or_none() is not None:
            return False  # already wrote this — skip

        row = NodeExecution(
            workflow_run_id=workflow_run_id,
            node_key=node_key,
            status=status,
            input=input_snapshot,
            output=output_snapshot,
            tokens_prompt=tokens_prompt,
            tokens_completion=tokens_completion,
            cost_usd=cost_usd,
            latency_ms=latency_ms,
            attempt=attempt,
        )
        session.add(row)
        await session.commit()
    return True


def _usage_for_node(node_output: Any, node_key: str) -> dict[str, Any]:
    """
    Pull this node's token/cost bookkeeping off the `node_usage` state channel.

    Agent handlers return usage keyed by node_key; every other node type returns
    nothing, yielding an empty dict and NULL columns.
    """
    if not isinstance(node_output, dict):
        return {}
    usage = (node_output.get("node_usage") or {}).get(node_key)
    return usage if isinstance(usage, dict) else {}


def _output_snapshot(node_output: Any) -> dict[str, Any]:
    """
    Shape a handler's return value for the `output` audit column.

    `node_usage` is stripped: it now has dedicated tokens_prompt/tokens_completion/
    cost_usd columns, and duplicating it into the JSONB snapshot would let the two
    representations drift.
    """
    if not isinstance(node_output, dict):
        return {"value": node_output}
    return {key: value for key, value in node_output.items() if key != "node_usage"}


async def _add_run_cost(run_id: uuid.UUID, delta: float) -> None:
    """
    Increment workflow_runs.total_cost_usd by `delta` (Vol. 2 §3.2: "sum of node
    executions' cost").

    The increment happens SQL-side rather than read-modify-write in Python so
    concurrent writers cannot lose an update. Using the SQLAlchemy column
    expression instead of raw text() also sidesteps the `::cast` vs `:param`
    conflict that bites text() queries in this codebase.
    """
    async with async_session_maker() as session:
        from sqlalchemy import update as sa_update

        await session.execute(
            sa_update(WorkflowRun).where(WorkflowRun.id == run_id).values(total_cost_usd=func.coalesce(WorkflowRun.total_cost_usd, 0) + delta)
        )
        await session.commit()


async def _mark_failed(run_id: uuid.UUID, error_detail: str) -> None:
    await _update_run(
        run_id,
        status="failed",
        completed_at=datetime.now(UTC),
        error={"message": error_detail},
    )


# ---------------------------------------------------------------------------
# Core stream loop (shared by execute and resume)
# ---------------------------------------------------------------------------


async def _resolve_llm_client_factory(organization_id: uuid.UUID) -> Callable[..., LLMClient]:
    """
    BYOK seam (Vol. 2 §13): resolve the org's stored OpenAI key, if any, and bind
    it as `api_key_override`. When no key is stored, `api_key_override=None`
    reproduces the pre-BYOK fallback to settings.OPENAI_API_KEY exactly.
    """
    async with async_session_maker() as session:
        api_key = await IntegrationService(session).get_decrypted_openai_key(organization_id)
    return functools.partial(get_llm_client, api_key_override=api_key)


async def _stream_graph(
    run_id: uuid.UUID,
    version: WorkflowVersion,
    stream_input: dict[str, Any] | Command,
    attempt: int,
    organization_id: uuid.UUID,
) -> None:
    """
    Compile the graph (fresh, with PostgresSaver), stream it to completion or
    interrupt, write NodeExecution rows after each superstep.
    """
    saver = PostgresSaver(async_session_maker)
    client_factory = await _resolve_llm_client_factory(organization_id)
    compiled, _ = _compile_state_graph(version, checkpointer=saver, client_factory=client_factory)

    config = {"configurable": {"thread_id": str(run_id)}}

    # Mark run as running
    await _update_run(run_id, status="running", started_at=datetime.now(UTC))

    node_start_time = time.monotonic()
    interrupted = False
    interrupt_payload: dict[str, Any] | None = None

    async for chunk in compiled.astream(stream_input, config, stream_mode="updates"):
        chunk_end_time = time.monotonic()
        latency_ms = max(1, int((chunk_end_time - node_start_time) * 1000))

        if "__interrupt__" in chunk:
            # Graph paused at a human_approval node — checkpoint already saved
            # by the PostgresSaver before this chunk was yielded.
            interrupts = chunk["__interrupt__"]
            if interrupts:
                interrupt_payload = interrupts[0].value if hasattr(interrupts[0], "value") else interrupts[0]
            interrupted = True
            break

        for node_key, node_output in chunk.items():
            # node_output from "updates" mode is the dict the handler returned.
            # The input snapshot is the full prior state; for audit purposes
            # we record just the output here (full state is in the checkpoint).
            usage = _usage_for_node(node_output, node_key)
            await _insert_node_execution(
                workflow_run_id=run_id,
                node_key=node_key,
                status="succeeded",
                input_snapshot=None,  # state snapshot not available in updates mode
                output_snapshot=_output_snapshot(node_output),
                latency_ms=latency_ms,
                attempt=attempt,
                tokens_prompt=usage.get("tokens_prompt"),
                tokens_completion=usage.get("tokens_completion"),
                cost_usd=usage.get("cost_usd"),
            )
            if usage.get("cost_usd"):
                await _add_run_cost(run_id, float(usage["cost_usd"]))

        node_start_time = time.monotonic()

    if interrupted:
        await _update_run(
            run_id,
            status="waiting_approval",
            current_node_key="human_approval",
            interrupt_payload=interrupt_payload,
        )
    else:
        await _update_run(
            run_id,
            status="completed",
            completed_at=datetime.now(UTC),
            current_node_key=None,
        )


# ---------------------------------------------------------------------------
# Celery tasks
# ---------------------------------------------------------------------------


@celery_app.task(
    bind=True,
    name="src.workers.graph_tasks.execute_workflow",
    max_retries=3,
    queue="workflow_execution",
    soft_time_limit=600,  # 10 min — kills task cleanly before hard limit
    time_limit=660,
)
def execute_workflow(self: Task, workflow_run_id: str) -> None:
    """
    Execute a workflow from scratch. Called by the executions service after
    creating a WorkflowRun row with status=pending.
    """
    run_id = uuid.UUID(workflow_run_id)
    attempt = self.request.retries + 1

    try:
        asyncio.run(_execute_workflow_async(run_id, attempt))
    except _NON_RETRYABLE as exc:
        logger.error("Non-retryable error in execute_workflow run=%s: %s", run_id, exc)
        asyncio.run(_mark_failed(run_id, str(exc)))
        return  # do not retry
    except Exception as exc:
        logger.warning("Transient error in execute_workflow run=%s attempt=%d: %s", run_id, attempt, exc)
        try:
            backoff = 2**self.request.retries  # 1s, 2s, 4s
            raise self.retry(exc=exc, countdown=backoff)
        except MaxRetriesExceededError:
            logger.error("Max retries exceeded for execute_workflow run=%s", run_id)
            asyncio.run(_mark_failed(run_id, f"Max retries exceeded. Last error: {exc}"))


async def _execute_workflow_async(run_id: uuid.UUID, attempt: int) -> None:
    loaded = await _load_run_with_version(run_id)
    if loaded is None:
        raise ValueError(f"WorkflowRun {run_id} not found")

    run, version = loaded

    # Idempotency guard: skip if another task already completed/failed this run.
    if run.status not in ("pending", "running"):
        logger.info("Skipping execute_workflow for run=%s (status=%s)", run_id, run.status)
        return

    initial_state = initial_state_from_trigger(
        organization_id=run.organization_id,
        trigger_payload=run.trigger_payload or {},
        run_id=str(run_id),
    )

    await _stream_graph(run_id, version, initial_state, attempt, run.organization_id)


@celery_app.task(
    bind=True,
    name="src.workers.graph_tasks.resume_workflow",
    max_retries=3,
    queue="workflow_execution",
    soft_time_limit=600,
    time_limit=660,
)
def resume_workflow(self: Task, workflow_run_id: str, resume_payload: dict[str, Any]) -> None:
    """
    Resume a run that is waiting_approval with an approval decision payload.
    Called by the executions service after validating decision="approved".
    Rejection is handled directly in the service (no graph execution needed).
    """
    run_id = uuid.UUID(workflow_run_id)
    attempt = self.request.retries + 1

    try:
        asyncio.run(_resume_workflow_async(run_id, resume_payload, attempt))
    except _NON_RETRYABLE as exc:
        logger.error("Non-retryable error in resume_workflow run=%s: %s", run_id, exc)
        asyncio.run(_mark_failed(run_id, str(exc)))
        return
    except Exception as exc:
        logger.warning("Transient error in resume_workflow run=%s attempt=%d: %s", run_id, attempt, exc)
        try:
            backoff = 2**self.request.retries
            raise self.retry(exc=exc, countdown=backoff)
        except MaxRetriesExceededError:
            logger.error("Max retries exceeded for resume_workflow run=%s", run_id)
            asyncio.run(_mark_failed(run_id, f"Max retries exceeded. Last error: {exc}"))


async def _resume_workflow_async(
    run_id: uuid.UUID,
    resume_payload: dict[str, Any],
    attempt: int,
) -> None:
    loaded = await _load_run_with_version(run_id)
    if loaded is None:
        raise ValueError(f"WorkflowRun {run_id} not found")

    run, version = loaded

    # Idempotency guard
    if run.status != "running":
        logger.info("Skipping resume_workflow for run=%s (status=%s)", run_id, run.status)
        return

    await _stream_graph(run_id, version, Command(resume=resume_payload), attempt, run.organization_id)
