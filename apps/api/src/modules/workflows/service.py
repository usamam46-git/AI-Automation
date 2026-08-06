"""
modules/workflows/service.py — Business logic for the Workflow shell and versioned graphs.

Critical business rules:
1. Before creating, verify that workspace_id belongs to the caller's org — explicit
   query, never relying on RLS to produce a clean 404 (per Vol. 2 §1.1 / §3.8).
2. Workflow status "published" is set only by publish_version — not via PATCH.
3. Soft-delete (archive) is the only deletion path — never hard-delete.
4. Published workflow versions are immutable — any mutation attempt returns 409.
5. Graph validation is split by intent, never run at execution time: save_draft
   enforces data integrity only (validate_draft_structure), while publish_version
   adds the full shape rules (validate_graph_structure) plus the mutating-tool
   approval guardrail (validate_mutating_approval). A draft is allowed to be an
   unfinished graph; a published version is not.
"""

import uuid
from collections.abc import Sequence

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.events import (
    WorkflowArchivedEvent,
    WorkflowCreatedEvent,
    WorkflowUpdatedEvent,
    WorkflowVersionPublishedEvent,
    WorkflowVersionSavedEvent,
    event_bus,
)
from src.core.redis import redis_client
from src.graphs.cache import invalidate_cached_graph
from src.modules.workflows.models import Workflow, WorkflowVersion
from src.modules.workflows.repository import WorkflowRepository
from src.modules.workflows.schemas import (
    EdgeInput,
    EdgeResponse,
    NodeInput,
    NodeResponse,
    NodeType,
    WorkflowCreate,
    WorkflowUpdate,
    WorkflowVersionCreate,
    WorkflowVersionResponse,
    WorkflowVersionSummary,
)
from src.modules.workspaces.models import Workspace


class GraphValidationError(Exception):
    """Raised when a workflow graph fails structural validation."""

    def __init__(self, detail: str | dict):
        self.detail = detail
        super().__init__(str(detail))


def validate_draft_structure(nodes: list[NodeInput], edges: list[EdgeInput]) -> None:
    """
    Data-integrity-only validation — safe to run against a half-built graph (save_draft).

    Deliberately excludes the *shape* rules that `validate_graph_structure` adds
    (start/end presence, orphans, cycles). The Builder canvas autosaves after every
    node drop and edge connection, and every intermediate state of a graph under
    construction violates at least one of them: a single dropped node has no start,
    a connected pair has no end, an unattached node is an orphan. Enforcing them here
    would mean a draft is only persistable once it is already complete — an author who
    dropped four nodes and closed the tab would lose all four.

    Same reasoning, and the same publish-time-only placement, as
    `validate_mutating_approval` below. What stays here are the two rules that would
    corrupt storage rather than merely describe an unfinished graph: `node_key` is the
    identity edges reference, so duplicates make the graph ambiguous, and an edge
    pointing at a nonexistent key cannot be stored coherently.
    """
    node_keys = [node.node_key for node in nodes]
    seen_keys: set[str] = set()
    duplicate_keys: list[str] = []
    for key in node_keys:
        if key in seen_keys and key not in duplicate_keys:
            duplicate_keys.append(key)
        seen_keys.add(key)
    if duplicate_keys:
        raise GraphValidationError(f"Duplicate node_key values: {sorted(duplicate_keys)}")

    node_key_set = set(node_keys)

    invalid_edges: list[dict[str, str]] = []
    for edge in edges:
        missing: list[str] = []
        if edge.source_node_key not in node_key_set:
            missing.append(f"source '{edge.source_node_key}'")
        if edge.target_node_key not in node_key_set:
            missing.append(f"target '{edge.target_node_key}'")
        if missing:
            invalid_edges.append(
                {
                    "source_node_key": edge.source_node_key,
                    "target_node_key": edge.target_node_key,
                    "missing": ", ".join(missing),
                }
            )
    if invalid_edges:
        raise GraphValidationError(
            {
                "message": "Edges reference nonexistent node_key values",
                "invalid_edges": invalid_edges,
            }
        )


def validate_graph_structure(nodes: list[NodeInput], edges: list[EdgeInput]) -> None:
    """
    Full structural validation — publish-time only (see `validate_draft_structure`).

    Checks:
    - Unique node_key values                    (via validate_draft_structure)
    - Edge endpoints reference existing nodes   (via validate_draft_structure)
    - At least one start and one end node
    - No orphan nodes (every non-start has incoming, every non-end has outgoing)
    - No cycles (loop support deferred to compiler phase)
    """
    validate_draft_structure(nodes, edges)

    node_key_set = {node.node_key for node in nodes}

    start_nodes = [node.node_key for node in nodes if _node_type_str(node.node_type) == NodeType.start.value]
    end_nodes = [node.node_key for node in nodes if _node_type_str(node.node_type) == NodeType.end.value]

    if not start_nodes:
        raise GraphValidationError("Graph must contain at least one start node.")
    if not end_nodes:
        raise GraphValidationError("Graph must contain at least one end node.")

    incoming = dict.fromkeys(node_key_set, 0)
    outgoing = dict.fromkeys(node_key_set, 0)
    for edge in edges:
        outgoing[edge.source_node_key] += 1
        incoming[edge.target_node_key] += 1

    # Scanned once, after the full edge tally — not inside the loop above. Previously
    # `orphan_keys` was initialised inside `for edge in edges`, which left it unbound when
    # `edges` was empty: a graph of just start+end raised UnboundLocalError, so the
    # endpoint returned 500 instead of a validation error. It also redid the whole scan on
    # every edge iteration against partial counts, with only the final pass surviving —
    # same answer, wasted work. The `not in orphan_keys` guard additionally bound to only
    # one arm of the `or`; it was dead either way, since each node is visited once.
    orphan_keys: list[str] = []
    for node in nodes:
        node_type = _node_type_str(node.node_type)
        missing_incoming = node_type != NodeType.start.value and incoming[node.node_key] == 0
        missing_outgoing = node_type != NodeType.end.value and outgoing[node.node_key] == 0
        if (missing_incoming or missing_outgoing) and node.node_key not in orphan_keys:
            orphan_keys.append(node.node_key)
    if orphan_keys:
        raise GraphValidationError(f"Orphan nodes detected (missing required edges): {sorted(orphan_keys)}")

    cycle_path = _find_cycle(node_key_set, edges)
    if cycle_path:
        raise GraphValidationError(f"Cycle detected in graph: {' -> '.join(cycle_path)}")


def _node_type_str(node_type: NodeType | str) -> str:
    return node_type.value if isinstance(node_type, NodeType) else str(node_type)


def _find_cycle(node_keys: set[str], edges: list[EdgeInput]) -> list[str] | None:
    adjacency: dict[str, list[str]] = {key: [] for key in node_keys}
    for edge in edges:
        adjacency[edge.source_node_key].append(edge.target_node_key)

    state: dict[str, int] = dict.fromkeys(node_keys, 0)  # 0=unvisited, 1=visiting, 2=done

    def dfs(node: str, stack: list[str]) -> list[str] | None:
        state[node] = 1
        stack.append(node)
        for neighbor in adjacency[node]:
            if state[neighbor] == 0:
                cycle = dfs(neighbor, stack)
                if cycle:
                    return cycle
            elif state[neighbor] == 1:
                cycle_start = stack.index(neighbor)
                return stack[cycle_start:] + [neighbor]
        stack.pop()
        state[node] = 2
        return None

    for node_key in node_keys:
        if state[node_key] == 0:
            cycle = dfs(node_key, [])
            if cycle:
                return cycle
    return None


def validate_mutating_approval(nodes: list[NodeInput], edges: list[EdgeInput]) -> None:
    """
    Reject a graph where a mutating node has no `human_approval` node upstream (Vol. 4 §4.3).

    Deliberately NOT part of `validate_graph_structure`: that runs at save_draft too,
    and blocking Save would stop an author from parking a half-built graph while they
    wire the approval gate. This is a publish-time gate only.

    Semantics are ∃, not ∀: a mutating node is flagged only when *zero* human_approval
    nodes exist anywhere in its ancestor set — not when some individual path to it
    skips one. Vol. 4 §4.3's wording is "has **no** upstream approval node in its
    dependency path", and ∀ would reject the blueprint's own reference workflows:
    both Vol. 5 §1 (Invoice Processing) and Vol. 5 §5 (Journal Validation) route
    straight to the journal-entry write on their non-anomalous branch. The residual
    risk — that auto-approve branch posting with no human in the loop — is the
    blueprint's design decision, not a gap here.

    `is_mutating` is read from the node's inline `config`, since the tools module is
    models-only and there is no Tool row to resolve `tool_id` against. Only a literal
    `True` counts; `_tool_config` rejects non-bool values at invoke time so a string
    "true" cannot quietly read as non-mutating here.
    """
    mutating_keys = [node.node_key for node in nodes if (node.config or {}).get("is_mutating") is True]
    if not mutating_keys:
        return

    approval_keys = {node.node_key for node in nodes if _node_type_str(node.node_type) == NodeType.human_approval.value}

    # Reverse adjacency (target -> sources): the same idiom as _find_cycle's forward
    # adjacency, inverted, so a walk from a node reaches its ancestors. Condition
    # nodes are traversed naturally — they exist as stored rows and are only elided
    # later, at compile time.
    ancestors_of: dict[str, list[str]] = {node.node_key: [] for node in nodes}
    for edge in edges:
        if edge.target_node_key in ancestors_of:
            ancestors_of[edge.target_node_key].append(edge.source_node_key)

    unguarded: list[str] = []
    for mutating_key in mutating_keys:
        # Iterative rather than _find_cycle's recursion: no RecursionError ceiling on
        # a deep graph. The visited set also makes this safe independently of the
        # cycle check that validate_graph_structure already ran.
        seen: set[str] = set()
        queue = list(ancestors_of.get(mutating_key, []))
        approved = False
        while queue:
            current = queue.pop()
            if current in seen:
                continue
            seen.add(current)
            if current in approval_keys:
                approved = True
                break
            queue.extend(ancestors_of.get(current, []))
        if not approved:
            unguarded.append(mutating_key)

    if unguarded:
        raise GraphValidationError(
            f"Mutating nodes have no human_approval node in their upstream dependency path: {sorted(unguarded)}. "
            f"A node marked 'is_mutating: true' writes to an external system (ERP writes, payments) and must be "
            f"reachable only after human approval (Vol. 4 §4.3)."
        )


def _nodes_edges_from_version(version: WorkflowVersion) -> tuple[list[NodeInput], list[EdgeInput]]:
    nodes = [
        NodeInput(
            node_key=node.node_key,
            node_type=NodeType(node.node_type),
            config=node.config or {},
            position_x=node.position_x or 0.0,
            position_y=node.position_y or 0.0,
        )
        for node in version.nodes
    ]
    edges = [
        EdgeInput(
            source_node_key=edge.source_node_key,
            target_node_key=edge.target_node_key,
            condition=edge.condition,
        )
        for edge in version.edges
    ]
    return nodes, edges


def _version_to_response(version: WorkflowVersion) -> WorkflowVersionResponse:
    return WorkflowVersionResponse(
        id=version.id,
        workflow_id=version.workflow_id,
        version_number=version.version_number,
        nodes=[NodeResponse.model_validate(node) for node in version.nodes],
        edges=[EdgeResponse.model_validate(edge) for edge in version.edges],
        published_by=version.published_by,
        published_at=version.published_at,
        created_at=version.created_at,
    )


class WorkflowService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repository = WorkflowRepository(db)

    async def _verify_workspace_belongs_to_org(self, organization_id: uuid.UUID, workspace_id: uuid.UUID) -> None:
        """
        Explicit ownership check — returns clean 404 if workspace doesn't belong to org.
        This is intentional service-layer validation; RLS is a defense-in-depth backstop
        that must NOT be relied on to produce a human-readable error.
        """
        stmt = select(Workspace).where(
            Workspace.id == workspace_id,
            Workspace.organization_id == organization_id,
            Workspace.is_active == True,  # noqa: E712
        )
        result = await self.db.execute(stmt)
        if result.scalar_one_or_none() is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Workspace not found.",
            )

    def _raise_validation_error(self, exc: GraphValidationError) -> None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=exc.detail) from exc

    async def create_workflow(self, organization_id: uuid.UUID, data: WorkflowCreate) -> Workflow:
        # Critical: verify workspace belongs to this org before inserting
        await self._verify_workspace_belongs_to_org(organization_id, data.workspace_id)

        create_data = data.model_dump()
        # Enum → string for SQLAlchemy
        create_data["trigger_type"] = (
            create_data["trigger_type"].value if hasattr(create_data["trigger_type"], "value") else create_data["trigger_type"]
        )
        create_data["status"] = "draft"

        workflow = await self.repository.create(organization_id, create_data)

        await event_bus.publish(WorkflowCreatedEvent(workflow_id=str(workflow.id), organization_id=str(organization_id)))
        return workflow

    async def get_workflow(self, organization_id: uuid.UUID, workflow_id: uuid.UUID) -> Workflow:
        workflow = await self.repository.get_by_id(organization_id, workflow_id)
        if not workflow:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workflow not found.")
        return workflow

    async def list_workflows(
        self,
        organization_id: uuid.UUID,
        workspace_id: uuid.UUID | None = None,
        status_filter: str | None = None,
        cursor: str | None = None,
        limit: int = 50,
    ) -> Sequence[Workflow]:
        return await self.repository.list_by_org(
            organization_id,
            workspace_id=workspace_id,
            status=status_filter,
            cursor=cursor,
            limit=limit,
        )

    async def update_workflow(self, organization_id: uuid.UUID, workflow_id: uuid.UUID, data: WorkflowUpdate) -> Workflow:
        # Ensure it exists and belongs to this org
        await self.get_workflow(organization_id, workflow_id)

        update_data = data.model_dump(exclude_unset=True)
        if not update_data:
            return await self.get_workflow(organization_id, workflow_id)

        # Coerce enums to strings for SQLAlchemy
        if "trigger_type" in update_data and hasattr(update_data["trigger_type"], "value"):
            update_data["trigger_type"] = update_data["trigger_type"].value
        if "status" in update_data and hasattr(update_data["status"], "value"):
            update_data["status"] = update_data["status"].value

        if update_data.get("status") == "published":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Use POST /workflows/{workflow_id}/versions/{version_id}/publish to publish a workflow.",
            )

        workflow = await self.repository.update(organization_id, workflow_id, update_data)

        await event_bus.publish(WorkflowUpdatedEvent(workflow_id=str(workflow.id), organization_id=str(organization_id)))
        return workflow

    async def delete_workflow(self, organization_id: uuid.UUID, workflow_id: uuid.UUID) -> None:
        await self.get_workflow(organization_id, workflow_id)
        await self.repository.soft_delete(organization_id, workflow_id)

        await event_bus.publish(WorkflowArchivedEvent(workflow_id=str(workflow_id), organization_id=str(organization_id)))

    async def save_draft(
        self,
        organization_id: uuid.UUID,
        workflow_id: uuid.UUID,
        data: WorkflowVersionCreate,
        user_id: uuid.UUID,
    ) -> WorkflowVersionResponse:
        await self.get_workflow(organization_id, workflow_id)

        # Draft-safe subset only — the Builder canvas autosaves mid-construction, and
        # the shape rules are deferred to publish_version. See validate_draft_structure.
        try:
            validate_draft_structure(data.nodes, data.edges)
        except GraphValidationError as exc:
            self._raise_validation_error(exc)

        latest_version = await self.repository.get_latest_version(workflow_id)

        if latest_version is not None and latest_version.published_at is None:
            version = await self.repository.replace_draft(latest_version, data.nodes, data.edges)
            if redis_client is not None:
                await invalidate_cached_graph(redis_client, str(version.id))
        else:
            next_version_number = (latest_version.version_number + 1) if latest_version else 1
            version = await self.repository.create_version(workflow_id, next_version_number, data.nodes, data.edges)

        await event_bus.publish(
            WorkflowVersionSavedEvent(
                workflow_id=str(workflow_id),
                version_id=str(version.id),
                organization_id=str(organization_id),
            )
        )
        _ = user_id  # reserved for future audit attribution on draft saves
        return _version_to_response(version)

    async def list_versions(self, organization_id: uuid.UUID, workflow_id: uuid.UUID) -> list[WorkflowVersionSummary]:
        await self.get_workflow(organization_id, workflow_id)
        versions = await self.repository.list_versions(workflow_id)
        return [
            WorkflowVersionSummary(
                id=version.id,
                version_number=version.version_number,
                published_at=version.published_at,
                node_count=len(version.nodes),
                edge_count=len(version.edges),
            )
            for version in versions
        ]

    async def get_version(
        self,
        organization_id: uuid.UUID,
        workflow_id: uuid.UUID,
        version_id: uuid.UUID,
    ) -> WorkflowVersionResponse:
        await self.get_workflow(organization_id, workflow_id)
        version = await self.repository.get_version_by_id_and_workflow(organization_id, workflow_id, version_id)
        if not version:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workflow version not found.")
        return _version_to_response(version)

    async def publish_version(
        self,
        organization_id: uuid.UUID,
        workflow_id: uuid.UUID,
        version_id: uuid.UUID,
        user_id: uuid.UUID,
    ) -> WorkflowVersionResponse:
        await self.get_workflow(organization_id, workflow_id)
        version = await self.repository.get_version_by_id_and_workflow(organization_id, workflow_id, version_id)
        if not version:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workflow version not found.")

        if version.published_at is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Workflow version is already published and immutable.",
            )

        nodes, edges = _nodes_edges_from_version(version)
        try:
            validate_graph_structure(nodes, edges)
            # Publish-only, unlike the structural checks above: a draft may legitimately
            # hold a mutating node whose approval gate is not wired yet (Vol. 4 §4.3).
            validate_mutating_approval(nodes, edges)
        except GraphValidationError as exc:
            self._raise_validation_error(exc)

        version = await self.repository.mark_published(version_id, workflow_id, user_id)

        await event_bus.publish(
            WorkflowVersionPublishedEvent(
                workflow_id=str(workflow_id),
                version_id=str(version_id),
                organization_id=str(organization_id),
            )
        )
        return _version_to_response(version)
