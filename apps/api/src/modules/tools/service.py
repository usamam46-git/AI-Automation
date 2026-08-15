"""
modules/tools/service.py — business rules for the tool registry.

Vol. 2 §7.2: "Every tool's `input_schema` (JSON Schema) is what gets sent to
OpenAI as a function-calling/tool spec — meaning the tool registry **is** the
function-calling contract, with no separate 'adapter schema' to keep in sync."

Two things follow from taking that literally, and both are implemented here:

- A row is validated at write time by `validate_tool_config`, the public alias
  for the same `_tool_config` the executor calls. A row that saves is a row that
  runs, and `python_function`/`mcp` are rejected at create rather than stored as
  rows that only explode at invoke time.
- `function_specs()` builds the OpenAI tool array straight off the rows, with no
  intermediate representation.
"""

import uuid
from collections.abc import Sequence
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy import update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from src.graphs.node_handlers import ToolNodeConfigError, validate_tool_config
from src.modules.tools.models import Tool, ToolExecution
from src.modules.tools.repository import ToolRepository
from src.modules.tools.schemas import ToolCreate, ToolUpdate
from src.modules.workspaces.models import Workspace


class ToolExecutionLogger:
    """
    Writes `tool_executions` rows from inside a synchronous LangGraph node.

    Vol. 4 §4.3: "mutating tool calls emitted by an agent are logged to
    `tool_executions` *before* execution (not after), so a crash mid-call still
    leaves an audit trail of intent". `begin()` and `finish()` are therefore two
    **separately committed** transactions — that separation is the entire point.
    A single transaction spanning the call would roll the intent row back along
    with everything else on a crash, which is exactly the outcome §4.3 rules out.

    Synchronous by necessity, not by preference — see `src/db/sync_database.py`.

    Only registry-backed tool nodes log: `tool_executions.tool_id` is NOT NULL, so
    a node carrying inline config has no row to point at. That is a real
    limitation, and the concrete incentive to move nodes onto registry tools.

    `node_execution_id` starts NULL and is back-filled by `_stream_graph` once the
    superstep yields and the `node_executions` row exists. The FK is nullable for
    precisely this reason.
    """

    def __init__(self, session_maker: Any | None = None):
        self._session_maker = session_maker

    def _maker(self) -> Any:
        if self._session_maker is None:
            from src.db.sync_database import get_sync_session_maker

            self._session_maker = get_sync_session_maker()
        return self._session_maker

    def begin(self, tool_id: uuid.UUID, input_payload: dict[str, Any]) -> uuid.UUID:
        """Record the intent to call. Committed before the call goes out."""
        execution = ToolExecution(
            tool_id=tool_id,
            node_execution_id=None,
            input=input_payload,
            output=None,
            status="running",
            latency_ms=0,
        )
        with self._maker()() as session:
            session.add(execution)
            session.commit()
            return execution.id

    def finish(self, execution_id: uuid.UUID, *, status: str, output: dict[str, Any] | None, latency_ms: int) -> None:
        """
        Record the outcome. One row per node invocation, not per HTTP attempt —
        `_run_http_request` retries internally and `latency_ms` is the total
        across all attempts.
        """
        with self._maker()() as session:
            session.execute(
                sa_update(ToolExecution).where(ToolExecution.id == execution_id).values(status=status, output=output, latency_ms=latency_ms)
            )
            session.commit()


class ToolService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repository = ToolRepository(db)

    # -- helpers ------------------------------------------------------------

    async def _verify_workspace_belongs_to_org(self, organization_id: uuid.UUID, workspace_id: uuid.UUID) -> None:
        """Same idiom as WorkflowService — explicit 404, never a 403, never RLS."""
        stmt = select(Workspace).where(
            Workspace.id == workspace_id,
            Workspace.organization_id == organization_id,
            Workspace.is_active == True,  # noqa: E712
        )
        result = await self.db.execute(stmt)
        if result.scalar_one_or_none() is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found.")

    @staticmethod
    def _validate_input_schema(input_schema: dict[str, Any] | None, name: str) -> None:
        """
        Shallow structural check only.

        Full JSON Schema meta-validation would need the `jsonschema` package,
        which is not a dependency and isn't worth adding for this — OpenAI
        rejects a malformed spec at call time anyway. What's checked here is the
        shape that would break the `function_specs()` builder itself.
        """
        if input_schema is None:
            return
        if not isinstance(input_schema, dict):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"Tool '{name}': 'input_schema' must be a JSON object.")
        declared_type = input_schema.get("type")
        if declared_type is not None and declared_type != "object":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Tool '{name}': 'input_schema.type' must be 'object' — OpenAI function parameters are always an object.",
            )
        properties = input_schema.get("properties")
        if properties is not None and not isinstance(properties, dict):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Tool '{name}': 'input_schema.properties' must be a JSON object.",
            )

    @staticmethod
    def _validate_executable_config(tool_type: str, config: dict[str, Any] | None, is_mutating: bool, name: str) -> None:
        """Run the row through the executor's own validator; map its error to 422."""
        try:
            validate_tool_config({**(config or {}), "tool_type": tool_type, "is_mutating": is_mutating}, name)
        except ToolNodeConfigError as exc:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc

    async def _assert_name_free(self, workspace_id: uuid.UUID, name: str, exclude_id: uuid.UUID | None = None) -> None:
        if await self.repository.name_exists(workspace_id, name, exclude_id):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"A tool named '{name}' already exists in this workspace. Tool names are the LLM's function names and must be unique.",
            )

    # -- CRUD ---------------------------------------------------------------

    async def create_tool(self, organization_id: uuid.UUID, data: ToolCreate) -> Tool:
        await self._verify_workspace_belongs_to_org(organization_id, data.workspace_id)
        await self._assert_name_free(data.workspace_id, data.name)
        self._validate_input_schema(data.input_schema, data.name)
        self._validate_executable_config(data.tool_type, data.config, data.is_mutating, data.name)

        return await self.repository.create(organization_id, data.model_dump())

    async def get_tool(self, organization_id: uuid.UUID, tool_id: uuid.UUID) -> Tool:
        tool = await self.repository.get_by_id(organization_id, tool_id)
        if not tool:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tool not found.")
        return tool

    async def list_tools(
        self,
        organization_id: uuid.UUID,
        workspace_id: uuid.UUID | None = None,
        tool_type: str | None = None,
        cursor: str | None = None,
        limit: int = 50,
    ) -> Sequence[Tool]:
        return await self.repository.list_by_org(organization_id, workspace_id, tool_type, cursor, limit)

    async def update_tool(self, organization_id: uuid.UUID, tool_id: uuid.UUID, data: ToolUpdate) -> Tool:
        tool = await self.get_tool(organization_id, tool_id)
        update_data = data.model_dump(exclude_unset=True)
        if not update_data:
            return tool

        name = update_data.get("name", tool.name)
        if "name" in update_data:
            await self._assert_name_free(tool.workspace_id, name, exclude_id=tool_id)
        if "input_schema" in update_data:
            self._validate_input_schema(update_data["input_schema"], name)

        # Re-validate the whole executable shape whenever either half moves —
        # a config edit and an is_mutating edit can each invalidate the other.
        if "config" in update_data or "is_mutating" in update_data:
            self._validate_executable_config(
                tool.tool_type,
                update_data.get("config", tool.config),
                update_data.get("is_mutating", tool.is_mutating),
                name,
            )

        return await self.repository.update(organization_id, tool_id, update_data)

    async def delete_tool(self, organization_id: uuid.UUID, tool_id: uuid.UUID) -> None:
        """
        Soft delete. A hard delete would cascade to `tool_executions` and destroy
        the audit trail Vol. 4 §4.3 exists to create.
        """
        await self.get_tool(organization_id, tool_id)

        references = await self.repository.count_published_references(organization_id, tool_id)
        if references > 0:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Cannot delete tool because {references} node(s) in published workflow version(s) reference it.",
            )

        await self.repository.soft_delete(organization_id, tool_id)

    # -- run-start resolution (Vol. 2 §7.2) ---------------------------------

    #: Keys a workflow node may override on a registry tool. These are per-usage
    #: state wiring — which bits of graph state feed this particular call site.
    #:
    #: Everything else (url, method, headers, action, timeout_seconds, is_mutating)
    #: comes from the registry and is deliberately NOT overridable. A node that
    #: could re-point a tool's `url` would let an author aim a tool the org
    #: reviewed and marked non-mutating at an arbitrary endpoint, while the
    #: publish-time approval gate went on reading `is_mutating=false` off the
    #: registry row it no longer describes.
    #:
    #: `query`/`query_fields` join the set for `knowledge_search` (days 6-7) —
    #: the question asked is per-usage, exactly like a request body.
    #: `knowledge_base_id` pointedly does NOT: it is the retrieval target, the
    #: direct analogue of `url`, and letting a node swap the corpus underneath a
    #: reviewed tool is the same hole in a different coat. `top_k` and
    #: `score_floor` stay registry-owned too — they are the tuning an org
    #: reviewed, and a node quietly widening the floor to 0 turns a curated
    #: retrieval into a noise generator that still looks approved.
    NODE_OVERRIDABLE_KEYS = frozenset({"body", "body_fields", "payload", "payload_fields", "query", "query_fields"})

    async def resolve_node_configs(
        self,
        organization_id: uuid.UUID,
        nodes: Sequence[Any],
    ) -> dict[str, dict[str, Any]]:
        """
        Resolve tool nodes that reference the registry into inline-config shape.

        Returns `{node_key: merged_config}` for registry-backed nodes only. A node
        carrying inline `tool_type` is skipped entirely — inline config always wins,
        which is what keeps every pre-registry graph (and the Builder's node catalog)
        working untouched.

        Called once per run, before compile, and the merged dict is fed to the
        unchanged `_tool_config`, so `tool_handler` never learns the registry exists.

        Raises ToolNodeConfigError when a referenced tool can't be resolved — it's
        already in `_NON_RETRYABLE` in graph_tasks, so the run fails fast with a
        clear message instead of dying mid-graph. Publish already caught this case;
        what reaches here is a tool soft-deleted *after* the version was published.
        """
        wanted: dict[str, uuid.UUID] = {}
        for node in nodes:
            if node.node_type != "tool":
                continue
            config = node.config or {}
            if config.get("tool_type"):
                continue  # inline config wins
            raw = config.get("tool_id")
            if not raw:
                continue
            try:
                wanted[node.node_key] = uuid.UUID(str(raw))
            except (ValueError, AttributeError, TypeError):
                raise ToolNodeConfigError(f"Tool node '{node.node_key}' has a malformed 'tool_id' ({raw!r}) — expected a UUID.")

        if not wanted:
            return {}

        by_id = {t.id: t for t in await self.repository.get_many_by_ids(organization_id, list(set(wanted.values())))}

        resolved: dict[str, dict[str, Any]] = {}
        for node in nodes:
            tool_id = wanted.get(getattr(node, "node_key", None))
            if tool_id is None:
                continue
            tool = by_id.get(tool_id)
            if tool is None:
                raise ToolNodeConfigError(
                    f"Tool node '{node.node_key}' references tool {tool_id} which is not in this organization's registry "
                    f"(deleted, or never existed)."
                )
            overrides = {k: v for k, v in (node.config or {}).items() if k in self.NODE_OVERRIDABLE_KEYS}
            resolved[node.node_key] = {
                **(tool.config or {}),
                "tool_type": tool.tool_type,
                "is_mutating": tool.is_mutating,
                "tool_id": str(tool.id),
                **overrides,
            }
        return resolved

    # -- function-calling contract (Vol. 2 §7.2, Vol. 4 §4.1) ----------------

    async def function_specs(self, organization_id: uuid.UUID, tool_ids: Sequence[uuid.UUID]) -> list[dict[str, Any]]:
        """
        Build the OpenAI `tools=` array for a set of registry tools.

        Ordered by the caller's `tool_ids` so the spec list is deterministic —
        prompt caching and golden-set evaluation both get noisier if the tool
        array reshuffles between otherwise identical calls. Ids that don't
        resolve are skipped rather than raising: the caller (a future agent
        node) decides whether a missing tool is fatal.

        Nothing invokes this yet — the ReAct loop is deferred (see the tools
        section of apps/api/CLAUDE.md). It exists now because it is the whole
        content of §7.2's claim and costs nothing to keep correct.
        """
        by_id = {t.id: t for t in await self.repository.get_many_by_ids(organization_id, tool_ids)}
        specs: list[dict[str, Any]] = []
        for tool_id in tool_ids:
            tool = by_id.get(tool_id)
            if tool is None:
                continue
            specs.append(
                {
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description or "",
                        "parameters": tool.input_schema or {"type": "object", "properties": {}},
                    },
                }
            )
        return specs
