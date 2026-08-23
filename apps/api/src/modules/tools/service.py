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

import json
import logging
import re
import uuid
from collections.abc import Sequence
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy import update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.encryption import decrypt_secret, encrypt_secret
from src.graphs.node_handlers import ToolNodeConfigError, validate_tool_config
from src.modules.tools.models import Tool, ToolExecution
from src.modules.tools.repository import ToolRepository
from src.modules.tools.schemas import ToolCreate, ToolUpdate
from src.modules.workspaces.models import Workspace

logger = logging.getLogger(__name__)

#: `{{secrets.erp_token}}` inside any string in a tool's `config`. The name grammar
#: matches the config keys authors already write and deliberately excludes `}` and
#: whitespace so the reference cannot run past its own delimiter.
SECRET_REF_RE = re.compile(r"\{\{\s*secrets\.([a-zA-Z0-9_.-]{1,64})\s*\}\}")

#: Cap on the stored secret map. Not a security boundary — a guard against a
#: client posting a megabyte of "credentials" into a column that is decrypted on
#: every read of the tools list.
MAX_SECRETS_PER_TOOL = 25
MAX_SECRET_VALUE_LENGTH = 4096


def collect_secret_refs(value: Any) -> set[str]:
    """Every `{{secrets.<name>}}` reachable anywhere inside a config, at any depth."""
    if isinstance(value, str):
        return set(SECRET_REF_RE.findall(value))
    if isinstance(value, dict):
        return set().union(*(collect_secret_refs(v) for v in value.values())) if value else set()
    if isinstance(value, list | tuple):
        return set().union(*(collect_secret_refs(v) for v in value)) if value else set()
    return set()


def inject_secrets(value: Any, secrets: dict[str, str]) -> Any:
    """
    Substitute `{{secrets.<name>}}` throughout a config, returning a new structure.

    Substitution is textual so a reference can sit inside a larger string — the
    common case is `"Bearer {{secrets.erp_token}}"`, where the scheme prefix is
    config and only the token is a credential.

    An UNKNOWN name is left in place rather than replaced with an empty string.
    Blanking it would send `Authorization: Bearer ` and earn a 401 that reads as a
    revoked credential; leaving the literal placeholder makes the cause obvious in
    the error the server returns. Write-time validation is what should catch this
    first — see `_validate_secret_refs` — so reaching here means the secret was
    removed after the config referencing it was saved.
    """
    if isinstance(value, str):
        return SECRET_REF_RE.sub(lambda m: secrets.get(m.group(1), m.group(0)), value)
    if isinstance(value, dict):
        return {k: inject_secrets(v, secrets) for k, v in value.items()}
    if isinstance(value, list):
        return [inject_secrets(v, secrets) for v in value]
    return value


def encode_secrets(secrets: dict[str, str] | None) -> bytes | None:
    """Serialize and encrypt the secret map. An empty map stores NULL, not an empty blob."""
    if not secrets:
        return None
    return encrypt_secret(json.dumps(secrets, separators=(",", ":"), sort_keys=True))


def decode_secrets(blob: bytes | None) -> dict[str, str]:
    """
    Decrypt the stored secret map.

    Returns `{}` on a decrypt failure rather than raising, and logs it. The blob is
    unreadable only if `INTEGRATION_ENCRYPTION_KEY` was rotated (AES-GCM
    authenticates, so a rotation destroys old ciphertext rather than degrading it),
    and in that case every tool in the org is affected at once. Raising here would
    take down the tools LIST endpoint — the one screen an author needs in order to
    re-enter the credentials. Failing at run time instead is both louder and better
    placed: `inject_secrets` leaves the literal placeholder, the call gets a 401,
    and the error names the tool.
    """
    if not blob:
        return {}
    try:
        loaded = json.loads(decrypt_secret(bytes(blob)))
    except Exception:
        logger.error("Failed to decrypt tool secrets — has INTEGRATION_ENCRYPTION_KEY been rotated?", exc_info=True)
        return {}
    return loaded if isinstance(loaded, dict) else {}


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
    def _validate_secrets(secrets: dict[str, str] | None, name: str) -> None:
        if not secrets:
            return
        if len(secrets) > MAX_SECRETS_PER_TOOL:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Tool '{name}': at most {MAX_SECRETS_PER_TOOL} secrets per tool.",
            )
        for key, value in secrets.items():
            if not re.fullmatch(r"[a-zA-Z0-9_.-]{1,64}", key):
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"Tool '{name}': secret name {key!r} must match [a-zA-Z0-9_.-]{{1,64}} so it can be referenced as {{{{secrets.{key}}}}}.",
                )
            if not isinstance(value, str) or not value:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"Tool '{name}': secret {key!r} must be a non-empty string.",
                )
            if len(value) > MAX_SECRET_VALUE_LENGTH:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"Tool '{name}': secret {key!r} exceeds {MAX_SECRET_VALUE_LENGTH} characters.",
                )

    @staticmethod
    def _validate_secret_refs(config: dict[str, Any] | None, secrets: dict[str, str], name: str) -> None:
        """
        Every `{{secrets.x}}` in the config must name a stored secret.

        Checked at WRITE time so a typo is a 422 on the tool form rather than a
        401 from the vendor three days later, at which point it is indistinguishable
        from a revoked key. The reverse (a stored secret nothing references) is
        allowed — an author may add the credential before wiring it up.
        """
        missing = sorted(collect_secret_refs(config) - secrets.keys())
        if missing:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=(
                    f"Tool '{name}': config references secret(s) {missing} that are not stored on this tool. "
                    f"Add them under 'secrets', or correct the reference."
                ),
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
        self._validate_secrets(data.secrets, data.name)
        self._validate_secret_refs(data.config, data.secrets or {}, data.name)
        self._validate_executable_config(data.tool_type, data.config, data.is_mutating, data.name)

        payload = data.model_dump()
        payload["secrets_encrypted"] = encode_secrets(payload.pop("secrets", None))
        return await self.repository.create(organization_id, payload)

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

        # `secrets` REPLACES the stored map wholesale when present, so the refs check
        # below must run against the post-update map: removing a secret while a
        # config still references it has to fail, and so does adding a reference
        # without the secret. Absent (exclude_unset) means untouched.
        effective_secrets = update_data["secrets"] if "secrets" in update_data else decode_secrets(tool.secrets_encrypted)
        if "secrets" in update_data:
            self._validate_secrets(update_data["secrets"], name)
        if "config" in update_data or "secrets" in update_data:
            self._validate_secret_refs(update_data.get("config", tool.config), effective_secrets or {}, name)

        # Re-validate the whole executable shape whenever either half moves —
        # a config edit and an is_mutating edit can each invalidate the other.
        if "config" in update_data or "is_mutating" in update_data:
            self._validate_executable_config(
                tool.tool_type,
                update_data.get("config", tool.config),
                update_data.get("is_mutating", tool.is_mutating),
                name,
            )

        if "secrets" in update_data:
            update_data["secrets_encrypted"] = encode_secrets(update_data.pop("secrets"))

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
    #: `url_fields`, `params` and `params_fields` joined the set on 2026-08-23 with
    #: URL templating. They are per-usage wiring in the same sense as `body_fields`:
    #: the registry owns the URL TEMPLATE, and `_url_template` validates that a
    #: node can only fill placeholders the template already declares. A node
    #: therefore cannot re-point the host, the scheme or the path shape — it can
    #: only say where this call site's `{invoice_id}` comes from. `_resolve_url`
    #: percent-encodes every substituted value with `safe=""`, so a value cannot
    #: add a path segment or a query parameter either.
    #:
    #: `idempotency` is pointedly NOT overridable: it is an assertion about the
    #: TARGET ENDPOINT's behaviour, which is the registry's to make. A node adding
    #: it would be claiming a dedupe guarantee on a server it does not own, and the
    #: only thing that claim does is re-enable retries on a mutating write.
    #: `title`, `body` and `user_id` joined for the `notify` type (2026-08-23):
    #: the message and its recipient are per-usage, exactly like a request body.
    #: `channel` and `url` are registry-owned — the transport is the direct
    #: analogue of `http_request`'s `url`, and a node that could re-point a
    #: reviewed notify tool at its own webhook would exfiltrate whatever the
    #: workflow put in the payload.
    NODE_OVERRIDABLE_KEYS = frozenset(
        {
            "body",
            "body_fields",
            "payload",
            "payload_fields",
            "query",
            "query_fields",
            "url_fields",
            "params",
            "params_fields",
            "title",
            "user_id",
        }
    )

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
            merged = {
                **(tool.config or {}),
                "tool_type": tool.tool_type,
                "is_mutating": tool.is_mutating,
                "tool_id": str(tool.id),
                **overrides,
            }
            # Credentials are substituted LAST and only here, at run start, so the
            # decrypted value exists solely in the worker's memory for the duration
            # of the run. It is never written back to a node, never serialized into
            # a response, and never reaches `tool_executions` — `_audit_input` drops
            # headers wholesale, which is what makes that safe.
            #
            # Overrides are injected too: a node-supplied `body` may legitimately
            # reference a secret, and skipping them would substitute inconsistently
            # depending on which half of the merge a reference landed in.
            secrets = decode_secrets(tool.secrets_encrypted)
            resolved[node.node_key] = inject_secrets(merged, secrets) if secrets else merged
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
