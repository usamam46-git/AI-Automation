"""
modules/workflows/repository.py — SQLAlchemy queries for workflows and versioned graphs.

Scope: Workflow shell CRUD plus workflow_versions, workflow_nodes, workflow_edges.
"""

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime

from sqlalchemy import delete, desc, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from src.modules.workflows.models import Workflow, WorkflowEdge, WorkflowNode, WorkflowVersion
from src.modules.workflows.schemas import EdgeInput, NodeInput, NodeType


def _build_graph_definition(nodes: list[NodeInput], edges: list[EdgeInput]) -> dict:
    return {
        "nodes": [node.model_dump(mode="json") for node in nodes],
        "edges": [edge.model_dump(mode="json") for edge in edges],
    }


def _node_type_value(node_type: NodeType | str) -> str:
    return node_type.value if hasattr(node_type, "value") else str(node_type)


class WorkflowRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def create(self, organization_id: uuid.UUID, data: dict) -> Workflow:
        workflow = Workflow(organization_id=organization_id, **data)
        self.db.add(workflow)
        await self.db.flush()
        return workflow

    async def get_by_id(self, organization_id: uuid.UUID, workflow_id: uuid.UUID) -> Workflow | None:
        stmt = select(Workflow).where(
            Workflow.id == workflow_id,
            Workflow.organization_id == organization_id,
            Workflow.status != "archived",
        )
        result = await self.db.execute(stmt)
        return result.scalar_one_or_none()

    async def get_by_id_unscoped(self, workflow_id: uuid.UUID) -> Workflow | None:
        """
        Fetch a workflow WITHOUT an organization_id filter.

        This is the one deliberate exception to the tenant-scoping rule in the
        root CLAUDE.md, and it exists for exactly one caller: the unauthenticated
        inbound webhook endpoint (POST /api/v1/triggers/workflows/{id}). That
        request carries no JWT, so there is no authenticated org to scope by —
        the caller proves authorization by HMAC instead, and the org identity is
        then READ OFF this row (`workflow.organization_id`) rather than supplied.
        That preserves the actual invariant: organization_id is never taken from
        client input.

        Do not reach for this anywhere else. Every authenticated path has an org
        in context and must use get_by_id(). Note also that ExecutionService
        verifies the HMAC before this row's contents influence anything, and
        returns an identical 401 for "no such workflow" so the endpoint cannot
        be used to enumerate workflow IDs across tenants.
        """
        stmt = select(Workflow).where(
            Workflow.id == workflow_id,
            Workflow.status != "archived",
        )
        result = await self.db.execute(stmt)
        return result.scalar_one_or_none()

    async def mark_triggered(self, workflow_id: uuid.UUID, *, next_run_at: datetime | None) -> None:
        """
        Record that a trigger just enqueued a run, and arm the next occurrence.

        Unscoped by org for the same reason as get_by_id_unscoped — both trigger
        paths (the beat tick and the webhook) have already established authority
        by other means.
        """
        stmt = update(Workflow).where(Workflow.id == workflow_id).values(last_triggered_at=datetime.now(UTC), next_run_at=next_run_at)
        await self.db.execute(stmt)

    async def list_by_org(
        self,
        organization_id: uuid.UUID,
        workspace_id: uuid.UUID | None = None,
        status: str | None = None,
        cursor: str | None = None,
        limit: int = 50,
    ) -> Sequence[Workflow]:
        stmt = select(Workflow).where(Workflow.organization_id == organization_id).order_by(desc(Workflow.created_at)).limit(limit)

        if workspace_id is not None:
            stmt = stmt.where(Workflow.workspace_id == workspace_id)

        if status is not None:  # noqa: SIM108
            stmt = stmt.where(Workflow.status == status)
        else:
            # By default, exclude archived workflows from list
            stmt = stmt.where(Workflow.status != "archived")

        if cursor:
            try:
                cursor_dt = datetime.fromisoformat(cursor)
                stmt = stmt.where(Workflow.created_at < cursor_dt)
            except ValueError:
                pass

        result = await self.db.execute(stmt)
        return result.scalars().all()

    async def update(self, organization_id: uuid.UUID, workflow_id: uuid.UUID, data: dict) -> Workflow:
        stmt = (
            update(Workflow)
            .where(
                Workflow.id == workflow_id,
                Workflow.organization_id == organization_id,
            )
            .values(**data)
            .returning(Workflow)
        )
        result = await self.db.execute(stmt)
        await self.db.flush()
        return result.scalar_one()

    async def soft_delete(self, organization_id: uuid.UUID, workflow_id: uuid.UUID) -> None:
        """Archive a workflow (soft delete). Never hard-deletes."""
        stmt = (
            update(Workflow)
            .where(
                Workflow.id == workflow_id,
                Workflow.organization_id == organization_id,
            )
            .values(status="archived")
        )
        await self.db.execute(stmt)
        await self.db.flush()

    async def count_active_for_workspace(self, organization_id: uuid.UUID, workspace_id: uuid.UUID) -> int:
        """Count non-archived workflows in a workspace. Used by workspace deletion guard."""
        stmt = select(func.count(Workflow.id)).where(
            Workflow.workspace_id == workspace_id,
            Workflow.organization_id == organization_id,
            Workflow.status != "archived",
        )
        result = await self.db.execute(stmt)
        return result.scalar_one()

    # ------------------------------------------------------------------
    # Workflow version / graph repository methods
    # ------------------------------------------------------------------

    async def get_latest_version(self, workflow_id: uuid.UUID) -> WorkflowVersion | None:
        stmt = (
            select(WorkflowVersion)
            .where(WorkflowVersion.workflow_id == workflow_id)
            .order_by(desc(WorkflowVersion.version_number))
            .limit(1)
            .options(selectinload(WorkflowVersion.nodes), selectinload(WorkflowVersion.edges))
        )
        result = await self.db.execute(stmt)
        return result.scalar_one_or_none()

    async def get_latest_draft(self, workflow_id: uuid.UUID) -> WorkflowVersion | None:
        stmt = (
            select(WorkflowVersion)
            .where(
                WorkflowVersion.workflow_id == workflow_id,
                WorkflowVersion.published_at.is_(None),
            )
            .order_by(desc(WorkflowVersion.version_number))
            .limit(1)
            .options(selectinload(WorkflowVersion.nodes), selectinload(WorkflowVersion.edges))
        )
        result = await self.db.execute(stmt)
        return result.scalar_one_or_none()

    async def get_version_by_id(self, organization_id: uuid.UUID, version_id: uuid.UUID) -> WorkflowVersion | None:
        stmt = (
            select(WorkflowVersion)
            .join(Workflow, Workflow.id == WorkflowVersion.workflow_id)
            .where(
                WorkflowVersion.id == version_id,
                Workflow.organization_id == organization_id,
                Workflow.status != "archived",
            )
            .options(selectinload(WorkflowVersion.nodes), selectinload(WorkflowVersion.edges))
        )
        result = await self.db.execute(stmt)
        return result.scalar_one_or_none()

    async def get_version_by_id_and_workflow(
        self,
        organization_id: uuid.UUID,
        workflow_id: uuid.UUID,
        version_id: uuid.UUID,
    ) -> WorkflowVersion | None:
        stmt = (
            select(WorkflowVersion)
            .join(Workflow, Workflow.id == WorkflowVersion.workflow_id)
            .where(
                WorkflowVersion.id == version_id,
                WorkflowVersion.workflow_id == workflow_id,
                Workflow.organization_id == organization_id,
                Workflow.status != "archived",
            )
            .options(selectinload(WorkflowVersion.nodes), selectinload(WorkflowVersion.edges))
        )
        result = await self.db.execute(stmt)
        return result.scalar_one_or_none()

    async def list_versions(self, workflow_id: uuid.UUID) -> Sequence[WorkflowVersion]:
        stmt = (
            select(WorkflowVersion)
            .where(WorkflowVersion.workflow_id == workflow_id)
            .order_by(desc(WorkflowVersion.version_number))
            .options(selectinload(WorkflowVersion.nodes), selectinload(WorkflowVersion.edges))
        )
        result = await self.db.execute(stmt)
        return result.scalars().all()

    async def create_version(
        self,
        workflow_id: uuid.UUID,
        version_number: int,
        nodes: list[NodeInput],
        edges: list[EdgeInput],
    ) -> WorkflowVersion:
        """
        Insert a version row and all node/edge rows atomically.

        Atomicity: all writes run inside `async with self.db.begin_nested()` (SAVEPOINT)
        so any failure rolls back the version creation while preserving the outer
        request transaction managed by get_db_session().
        """
        graph_definition = _build_graph_definition(nodes, edges)

        async with self.db.begin_nested():
            version = WorkflowVersion(
                workflow_id=workflow_id,
                version_number=version_number,
                graph_definition=graph_definition,
            )
            self.db.add(version)
            await self.db.flush()

            for node in nodes:
                self.db.add(
                    WorkflowNode(
                        workflow_version_id=version.id,
                        node_key=node.node_key,
                        node_type=_node_type_value(node.node_type),
                        config=node.config,
                        position_x=node.position_x,
                        position_y=node.position_y,
                    )
                )

            for edge in edges:
                self.db.add(
                    WorkflowEdge(
                        workflow_version_id=version.id,
                        source_node_key=edge.source_node_key,
                        target_node_key=edge.target_node_key,
                        condition=edge.condition,
                    )
                )

            await self.db.flush()

        await self.db.refresh(version, attribute_names=["nodes", "edges"])
        return version

    async def replace_draft(
        self,
        version: WorkflowVersion,
        nodes: list[NodeInput],
        edges: list[EdgeInput],
    ) -> WorkflowVersion:
        """
        Replace all nodes/edges on an existing draft version atomically.

        Only callable against drafts (published_at IS NULL) — enforced at service layer.
        """
        graph_definition = _build_graph_definition(nodes, edges)

        async with self.db.begin_nested():
            await self.db.execute(delete(WorkflowEdge).where(WorkflowEdge.workflow_version_id == version.id))
            await self.db.execute(delete(WorkflowNode).where(WorkflowNode.workflow_version_id == version.id))

            version.graph_definition = graph_definition

            for node in nodes:
                self.db.add(
                    WorkflowNode(
                        workflow_version_id=version.id,
                        node_key=node.node_key,
                        node_type=_node_type_value(node.node_type),
                        config=node.config,
                        position_x=node.position_x,
                        position_y=node.position_y,
                    )
                )

            for edge in edges:
                self.db.add(
                    WorkflowEdge(
                        workflow_version_id=version.id,
                        source_node_key=edge.source_node_key,
                        target_node_key=edge.target_node_key,
                        condition=edge.condition,
                    )
                )

            await self.db.flush()

        await self.db.refresh(version, attribute_names=["nodes", "edges"])
        return version

    async def mark_published(
        self,
        version_id: uuid.UUID,
        workflow_id: uuid.UUID,
        published_by_user_id: uuid.UUID,
    ) -> WorkflowVersion:
        """
        Mark a draft version as published and set the parent workflow's current_version_id.

        Both updates run in a single transaction so they succeed or fail together.
        """
        now = datetime.now(UTC)

        async with self.db.begin_nested():
            version_stmt = (
                update(WorkflowVersion)
                .where(WorkflowVersion.id == version_id)
                .values(published_at=now, published_by=published_by_user_id)
                .returning(WorkflowVersion)
            )
            version_result = await self.db.execute(version_stmt)
            version = version_result.scalar_one()

            await self.db.execute(update(Workflow).where(Workflow.id == workflow_id).values(current_version_id=version_id, status="published"))
            await self.db.flush()

        await self.db.refresh(version, attribute_names=["nodes", "edges"])
        return version
