"""
workers/postgres_saver.py — Custom LangGraph BaseCheckpointSaver backed by
the workflow_runs.checkpoint_state JSONB column.

Design (per implementation decisions):
- thread_id = str(workflow_run.id).  Every aput()/aget_tuple() call resolves
  the run by parsing thread_id as a UUID and updating/reading that row.
- Serialization uses LangGraph's own JsonPlusSerializer so the full
  checkpoint tuple (including pending_sends, channel_versions, etc.) is
  preserved with full fidelity.
- aput_writes() appends pending writes to the same JSONB column; aput()
  saves the new checkpoint and clears pending writes atomically.
- Sync variants (required by BaseCheckpointSaver ABC) delegate to their
  async counterparts via asyncio.run(); they must NOT be called from within
  a running event loop.

Storage schema (workflow_runs.checkpoint_state):
{
    "v": 1,
    "checkpoint_ns": "",
    "checkpoint_id": "<langgraph-ts-id>",
    "parent_checkpoint_id": null | "<id>",
    "checkpoint": {"type": "<serde-type>", "data": "<base64>"},
    "metadata":   {"type": "<serde-type>", "data": "<base64>"},
    "pending_writes": [
        {"task_id": "...", "idx": 0, "channel": "...",
         "type": "<serde-type>", "data": "<base64>"}
    ]
}
"""

from __future__ import annotations

import asyncio
import base64
import json
import uuid
from collections.abc import AsyncIterator, Iterator
from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import (
    BaseCheckpointSaver,
    ChannelVersions,
    Checkpoint,
    CheckpointMetadata,
    CheckpointTuple,
)
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.modules.executions.models import WorkflowRun

_serde = JsonPlusSerializer()

STORAGE_VERSION = 1


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _encode(obj: Any) -> dict[str, str]:
    """Serialize an object to {type, data} using LangGraph's serde."""
    type_str, raw_bytes = _serde.dumps_typed(obj)
    return {"type": type_str, "data": base64.b64encode(raw_bytes).decode()}


def _decode(encoded: dict[str, str]) -> Any:
    """Deserialize from {type, data} back to the original object."""
    raw_bytes = base64.b64decode(encoded["data"])
    return _serde.loads_typed((encoded["type"], raw_bytes))


def _thread_id_to_run_id(config: RunnableConfig) -> uuid.UUID:
    thread_id: str = config["configurable"]["thread_id"]
    return uuid.UUID(thread_id)


def _checkpoint_ns(config: RunnableConfig) -> str:
    return config.get("configurable", {}).get("checkpoint_ns", "")


def _checkpoint_id(config: RunnableConfig) -> str | None:
    return config.get("configurable", {}).get("checkpoint_id")


def _build_config(thread_id: str, checkpoint_ns: str, checkpoint_id: str) -> RunnableConfig:
    return {
        "configurable": {
            "thread_id": thread_id,
            "checkpoint_ns": checkpoint_ns,
            "checkpoint_id": checkpoint_id,
        }
    }


# ---------------------------------------------------------------------------
# PostgresSaver
# ---------------------------------------------------------------------------


class PostgresSaver(BaseCheckpointSaver):
    """
    Stores LangGraph checkpoints in workflow_runs.checkpoint_state (JSONB).

    One checkpoint per WorkflowRun — identified by thread_id = str(run.id).
    Async-first: aput / aget_tuple / aput_writes are the primary implementations.
    Sync wrappers exist to satisfy the ABC but must not be called from within
    a running event loop.
    """

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        super().__init__()
        self._session_factory = session_factory

    # ------------------------------------------------------------------
    # Async — primary implementations
    # ------------------------------------------------------------------

    async def aget_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        run_id = _thread_id_to_run_id(config)
        async with self._session_factory() as session:
            stmt = select(WorkflowRun.checkpoint_state).where(WorkflowRun.id == run_id)
            result = await session.execute(stmt)
            row = result.scalar_one_or_none()

        if row is None:
            return None

        stored: dict[str, Any] = row
        checkpoint_id = stored["checkpoint_id"]
        checkpoint_ns = stored.get("checkpoint_ns", "")
        parent_id = stored.get("parent_checkpoint_id")
        thread_id = str(run_id)

        checkpoint: Checkpoint = _decode(stored["checkpoint"])
        metadata: CheckpointMetadata = _decode(stored["metadata"])

        # Reconstruct pending writes as list[PendingWrite] = list[tuple[str,str,Any]]
        pending_writes: list[tuple[str, str, Any]] = []
        for pw in stored.get("pending_writes", []):
            pending_writes.append((pw["task_id"], pw["channel"], _decode({"type": pw["type"], "data": pw["data"]})))

        current_config = _build_config(thread_id, checkpoint_ns, checkpoint_id)
        parent_config = _build_config(thread_id, checkpoint_ns, parent_id) if parent_id else None

        return CheckpointTuple(
            config=current_config,
            checkpoint=checkpoint,
            metadata=metadata,
            parent_config=parent_config,
            pending_writes=pending_writes or None,
        )

    async def aput(
        self,
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: ChannelVersions,
    ) -> RunnableConfig:
        run_id = _thread_id_to_run_id(config)
        thread_id = str(run_id)
        checkpoint_ns = _checkpoint_ns(config)
        # LangGraph passes the parent's checkpoint_id in the config; the new
        # checkpoint's id is in checkpoint["id"].
        parent_id = _checkpoint_id(config)
        new_checkpoint_id: str = checkpoint["id"]

        stored: dict[str, Any] = {
            "v": STORAGE_VERSION,
            "checkpoint_ns": checkpoint_ns,
            "checkpoint_id": new_checkpoint_id,
            "parent_checkpoint_id": parent_id,
            "checkpoint": _encode(checkpoint),
            "metadata": _encode(metadata),
            # aput() always resets pending_writes — they were for the
            # previous checkpoint; aput_writes() will add new ones if needed.
            "pending_writes": [],
        }

        async with self._session_factory() as session:
            await session.execute(
                update(WorkflowRun)
                .where(WorkflowRun.id == run_id)
                .values(checkpoint_state=stored)
            )
            await session.commit()

        return _build_config(thread_id, checkpoint_ns, new_checkpoint_id)

    async def aput_writes(
        self,
        config: RunnableConfig,
        writes: list[tuple[str, Any]],
        task_id: str,
    ) -> None:
        """
        Append pending writes (e.g. interrupt values) to the current checkpoint.

        Uses a single atomic SQL UPDATE with PostgreSQL's JSONB append operator
        to avoid a read-modify-write race with concurrent aput() background tasks.
        LangGraph's AsyncBackgroundExecutor submits aput() and aput_writes() as
        independent asyncio tasks, so they can interleave; a Python-level
        read-modify-write is not safe here.
        """
        if not writes:
            return

        run_id = _thread_id_to_run_id(config)

        new_writes_json = json.dumps(
            [
                {
                    "task_id": task_id,
                    "idx": idx,
                    "channel": channel,
                    **_encode(value),
                }
                for idx, (channel, value) in enumerate(writes)
            ]
        )

        async with self._session_factory() as session:
            await session.execute(
                text(
                    """
                    UPDATE workflow_runs
                    SET checkpoint_state = jsonb_set(
                        checkpoint_state,
                        '{pending_writes}',
                        COALESCE(checkpoint_state->'pending_writes', CAST('[]' AS jsonb))
                        || CAST(:new_writes AS jsonb)
                    )
                    WHERE id = CAST(:run_id AS uuid)
                    AND checkpoint_state IS NOT NULL
                    """
                ),
                {"new_writes": new_writes_json, "run_id": str(run_id)},
            )
            await session.commit()

    async def alist(
        self,
        config: RunnableConfig | None,
        *,
        filter: dict[str, Any] | None = None,
        before: RunnableConfig | None = None,
        limit: int | None = None,
    ) -> AsyncIterator[CheckpointTuple]:
        # Single-checkpoint-per-run design; listing returns the one checkpoint.
        if config is not None:
            result = await self.aget_tuple(config)
            if result is not None:
                yield result

    # ------------------------------------------------------------------
    # Sync — delegate to async variants; must not be called in event loop
    # ------------------------------------------------------------------

    def _run(self, coro: Any) -> Any:
        """Run a coroutine synchronously, safe to call only outside an event loop."""
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            pass
        else:
            raise RuntimeError(
                "PostgresSaver sync methods cannot be called from within a running "
                "event loop. Use the async variants (aget_tuple, aput, aput_writes)."
            )
        return asyncio.run(coro)

    def get_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        return self._run(self.aget_tuple(config))

    def put(
        self,
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: ChannelVersions,
    ) -> RunnableConfig:
        return self._run(self.aput(config, checkpoint, metadata, new_versions))

    def put_writes(
        self,
        config: RunnableConfig,
        writes: list[tuple[str, Any]],
        task_id: str,
    ) -> None:
        self._run(self.aput_writes(config, writes, task_id))

    def list(
        self,
        config: RunnableConfig | None,
        *,
        filter: dict[str, Any] | None = None,
        before: RunnableConfig | None = None,
        limit: int | None = None,
    ) -> Iterator[CheckpointTuple]:
        result = self._run(self.aget_tuple(config) if config else None)
        if result is not None:
            yield result
