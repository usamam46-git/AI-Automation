"""
modules/workflows/service.py — Business logic for the Workflow shell and versioned graphs.

Critical business rules:
1. Before creating, verify that workspace_id belongs to the caller's org — explicit
   query, never relying on RLS to produce a clean 404 (per Vol. 2 §1.1 / §3.8).
2. Status changes to "published" are allowed as a metadata flag only.
   TODO: Gate this behind graph compiler (§6.1) validation once compiler exists.
3. Soft-delete (archive) is the only deletion path — never hard-delete.
4. Published workflow versions are immutable — any mutation attempt returns 409.
5. Graph structural validation runs at save and publish time (not at execution).
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


def validate_graph_structure(nodes: list[NodeInput], edges: list[EdgeInput]) -> None:
    """
    Validate graph structure before persisting.

    Checks:
    - Unique node_key values
    - Edge endpoints reference existing nodes
    - At least one start and one end node
    - No orphan nodes (every non-start has incoming, every non-end has outgoing)
    - No cycles (loop support deferred to compiler phase)
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

    orphan_keys: list[str] = []
    for node in nodes:
        node_type = _node_type_str(node.node_type)
        if node_type != NodeType.start.value and incoming[node.node_key] == 0:
            orphan_keys.append(node.node_key)
        elif node_type != NodeType.end.value and outgoing[node.node_key] == 0 and node.node_key not in orphan_keys:
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

        # TODO (§6.1): When status is being changed to "published", validate against
        # graph compiler before allowing. For now this is a plain metadata flag.
        if update_data.get("status") == "published":
            pass  # Stub — compiler gate goes here

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

        try:
            validate_graph_structure(data.nodes, data.edges)
        except GraphValidationError as exc:
            self._raise_validation_error(exc)

        latest_version = await self.repository.get_latest_version(workflow_id)

        if latest_version is not None and latest_version.published_at is None:
            version = await self.repository.replace_draft(latest_version, data.nodes, data.edges)
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
        except GraphValidationError as exc:
            self._raise_validation_error(exc)

        # OPEN QUESTION: whether publish should also set Workflow.status = "published"
        # is pending product decision — currently decoupled from version publish.
        version = await self.repository.mark_published(version_id, workflow_id, user_id)

        await event_bus.publish(
            WorkflowVersionPublishedEvent(
                workflow_id=str(workflow_id),
                version_id=str(version_id),
                organization_id=str(organization_id),
            )
        )
        return _version_to_response(version)
