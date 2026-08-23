"""
src/db/demo/seed.py — stand up the demo corpus, tools and workflows.

Build-plan days 10-12. Run it inside the api container, which is the only
service that bind-mounts `src/`:

    docker exec -w /app aap_api python -m src.db.demo.seed --email you@example.com

## It seeds INTO an existing org, by design

`--email` names a user; the org is resolved from that user's active membership
and everything lands in that org's default workspace. The alternative — minting a
throwaway demo org — was rejected because it makes the seeded data invisible to
whoever is already logged in, and because the org's BYOK OpenAI key (if one is
stored) belongs to the real org and would not travel to a new one.

## It goes through the SERVICES, not the repositories

Every write below runs through `KnowledgeBaseService`, `ToolService` and
`WorkflowService` rather than touching tables directly. That is the whole point
of a seed script in this codebase: it exercises the same validation the UI does,
so a graph that seeds is a graph that publishes, and a config that seeds is one
`_tool_config` accepts. Writing rows straight into the database would let this
script create demo data the product itself would reject — which is exactly the
kind of demo that falls over in front of an audience.

The one consequence to know: services flush but mostly do not commit (the FastAPI
session dependency commits at the end of a request). So this script commits
explicitly between phases.

## It is idempotent

Re-running does not duplicate anything and does not re-spend on embeddings:

  - knowledge bases, tools and workflows are looked up by name and reused;
  - `upload_document` already deduplicates on content hash at upload, returning
    the existing indexed row and storing nothing (see the knowledge-base section
    of apps/api/CLAUDE.md);
  - a workflow whose published version already matches the desired graph is left
    alone, so version numbers do not climb on every run.

Editing a prompt in `graphs.py` and re-running therefore publishes exactly the
workflows that changed.

## RLS

The tenant policies are `ENABLE ROW LEVEL SECURITY`, not `FORCE`, and `aap_user`
owns the tables — so the owner bypasses them and this script would work without
setting anything. It sets `app.current_org_id` anyway, so the script runs under
the same constraint a request does and cannot accidentally become the one code
path that reads across tenants.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import io
import json
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import UploadFile
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.datastructures import Headers

import src.db.all_models  # noqa: F401 — register the full ORM graph before any query
from src.db.database import AsyncSessionLocal, engine
from src.db.demo.graphs import (
    SAMPLE_EXPENSE_PAYLOAD,
    SAMPLE_HR_PAYLOAD,
    SAMPLE_INVOICE_PAYLOAD,
    SAMPLE_LEAVE_REQUEST_PAYLOAD,
    DemoWorkflow,
    build_workflows,
)
from src.modules.audit_logs.schemas import AuditContext
from src.modules.auth.models import OrgMembership, User
from src.modules.knowledge_base.models import Document, KnowledgeBase
from src.modules.knowledge_base.schemas import KnowledgeBaseCreate
from src.modules.knowledge_base.service import KnowledgeBaseService
from src.modules.tools.schemas import ToolCreate, ToolUpdate
from src.modules.tools.service import ToolService
from src.modules.workflows.schemas import (
    EdgeInput,
    NodeInput,
    WorkflowCreate,
    WorkflowVersionCreate,
)
from src.modules.workflows.service import WorkflowService
from src.modules.workspaces.models import Workspace

CORPUS_DIR = Path(__file__).parent / "corpus"

#: Where the seed leaves what `send_invoice.py` needs to sign a request.
#:
#: /tmp rather than anywhere under the repo: the webhook signing secret is a
#: live credential that starts production runs with no login, and `src/` is
#: bind-mounted from the host working tree. A secret written there is one
#: `git add -A` away from being committed.
DEFAULT_STATE_FILE = Path("/tmp/orkest-demo.json")

#: (knowledge base name, embedding model, corpus files)
#:
#: TWO knowledge bases, not one. The split is the demo: `knowledge_base_id` is
#: registry-owned on a `knowledge_search` tool precisely so a reviewed retrieval
#: step cannot have its corpus swapped underneath it, and that guarantee means
#: nothing to look at when there is only one corpus to point at. It also keeps
#: the HR assistant honest — it can only ever answer from the handbook.
#:
#: `-small` on both: plan §6 reserves `-large` for a final demo corpus, and both
#: are requested at 1536 dimensions so switching later costs a re-index and no
#: migration.
FINANCE_KB = "Finance policies"
HANDBOOK_KB = "Employee handbook"
EMBEDDING_MODEL = "text-embedding-3-small"

_KB_CORPUS: dict[str, tuple[str, ...]] = {
    FINANCE_KB: ("ap-policy.md", "acme-vendor-msa.md", "expense-policy.md"),
    HANDBOOK_KB: ("employee-handbook.md",),
}

INDEXING_TIMEOUT_SECONDS = 300
INDEXING_POLL_SECONDS = 3


# ---------------------------------------------------------------------------
# Console
# ---------------------------------------------------------------------------


def _step(message: str) -> None:
    print(f"  → {message}", flush=True)


def _done(message: str) -> None:
    print(f"  ✓ {message}", flush=True)


def _warn(message: str) -> None:
    print(f"  ! {message}", flush=True)


def _heading(message: str) -> None:
    print(f"\n{message}", flush=True)


class SeedError(RuntimeError):
    """A precondition the script cannot repair — reported, never traced back."""


# ---------------------------------------------------------------------------
# Target resolution
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SeedTarget:
    user_id: uuid.UUID
    email: str
    organization_id: uuid.UUID
    workspace_id: uuid.UUID
    workspace_name: str


async def _resolve_target(db: AsyncSession, email: str) -> SeedTarget:
    """
    Find the org and workspace to seed into, from a user's email address.

    Fails loudly on every ambiguity rather than picking for you. Seeding into the
    wrong org is not visibly wrong until someone demos an empty account.
    """
    user = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
    if user is None:
        raise SeedError(f"No user with email {email!r}. Register in the app first, then re-run with that address.")

    memberships = (await db.execute(select(OrgMembership).where(OrgMembership.user_id == user.id, OrgMembership.status == "active"))).scalars().all()
    if not memberships:
        raise SeedError(f"{email} has no active organization membership.")
    if len(memberships) > 1:
        raise SeedError(
            f"{email} is an active member of {len(memberships)} organizations. "
            f"This script will not guess which one to seed; org ids: {[str(m.organization_id) for m in memberships]}."
        )

    organization_id = memberships[0].organization_id

    workspaces = (
        (await db.execute(select(Workspace).where(Workspace.organization_id == organization_id).order_by(Workspace.created_at))).scalars().all()
    )
    if not workspaces:
        raise SeedError("That organization has no workspace. Create one in the app first.")

    workspace = next((w for w in workspaces if w.is_default), workspaces[0])
    return SeedTarget(
        user_id=user.id,
        email=email,
        organization_id=organization_id,
        workspace_id=workspace.id,
        workspace_name=workspace.name,
    )


# ---------------------------------------------------------------------------
# Knowledge bases and the corpus
# ---------------------------------------------------------------------------


def _read_corpus(file_name: str) -> bytes:
    path = CORPUS_DIR / file_name
    if not path.is_file():
        raise SeedError(f"Corpus file missing: {path}")
    return path.read_bytes()


def _as_upload(file_name: str, data: bytes) -> UploadFile:
    """
    Wrap corpus bytes as the `UploadFile` the service expects.

    Going through `upload_document` rather than writing rows directly is what
    buys the content-hash dedup, the MinIO write and the `worker_documents`
    enqueue — i.e. the real ingestion path, which is the thing worth proving.
    """
    return UploadFile(
        file=io.BytesIO(data),
        size=len(data),
        filename=file_name,
        headers=Headers({"content-type": "text/markdown"}),
    )


async def _ensure_knowledge_bases(db: AsyncSession, target: SeedTarget) -> dict[str, KnowledgeBase]:
    service = KnowledgeBaseService(db)
    existing = {kb.name: kb for kb in await service.list_kbs(target.organization_id, target.workspace_id, None, 200)}

    resolved: dict[str, KnowledgeBase] = {}
    for name in _KB_CORPUS:
        kb = existing.get(name)
        if kb is None:
            kb = await service.create_kb(
                target.organization_id,
                KnowledgeBaseCreate(workspace_id=target.workspace_id, name=name, embedding_model=EMBEDDING_MODEL),
            )
            _done(f"knowledge base '{name}' created ({kb.embedding_model})")
        else:
            _step(f"knowledge base '{name}' already exists")
        resolved[name] = kb
    return resolved


async def _upload_corpus(db: AsyncSession, target: SeedTarget, kbs: dict[str, KnowledgeBase]) -> None:
    service = KnowledgeBaseService(db)
    for kb_name, file_names in _KB_CORPUS.items():
        kb = kbs[kb_name]
        for file_name in file_names:
            data = _read_corpus(file_name)
            document, deduplicated = await service.upload_document(target.organization_id, kb.id, _as_upload(file_name, data))
            if deduplicated:
                _step(f"{file_name} → already indexed in '{kb_name}', nothing stored and nothing embedded")
            else:
                _done(f"{file_name} → queued for ingestion in '{kb_name}' ({len(data):,} bytes, document {document.id})")


async def _wait_for_indexing(kb_ids: list[uuid.UUID], organization_id: uuid.UUID) -> None:
    """
    Block until every uploaded document reaches a terminal state.

    A fresh session per poll, deliberately: ingestion is happening in the
    `worker_documents` container, so the rows change underneath us. Reusing one
    session would serve the same objects out of its identity map forever and this
    would spin until the timeout with nothing appearing to happen.
    """
    deadline = time.monotonic() + INDEXING_TIMEOUT_SECONDS
    last_report = ""

    while True:
        async with AsyncSessionLocal() as poll_db:
            rows = (
                await poll_db.execute(
                    select(Document.file_name, Document.status, Document.error).where(
                        Document.organization_id == organization_id,
                        Document.knowledge_base_id.in_(kb_ids),
                    )
                )
            ).all()

        pending = [r for r in rows if r.status in {"uploaded", "processing"}]
        failed = [r for r in rows if r.status == "failed"]
        indexed = [r for r in rows if r.status == "indexed"]

        report = f"{len(indexed)} indexed, {len(pending)} in progress, {len(failed)} failed"
        if report != last_report:
            _step(report)
            last_report = report

        if not pending:
            for row in failed:
                _warn(f"{row.file_name} FAILED: {row.error}")
            if failed:
                raise SeedError(
                    "Ingestion failed for one or more documents. The usual cause is an OpenAI key the "
                    "worker cannot use — check `docker logs aap_worker_documents`."
                )
            _done(f"all {len(indexed)} documents indexed")
            return

        if time.monotonic() > deadline:
            raise SeedError(
                f"Timed out after {INDEXING_TIMEOUT_SECONDS}s with {len(pending)} document(s) still in progress. "
                "Check that aap_worker_documents is running and has the ingest_document task registered."
            )
        await asyncio.sleep(INDEXING_POLL_SECONDS)


# ---------------------------------------------------------------------------
# Registry tools
# ---------------------------------------------------------------------------


def _tool_specs(finance_kb_id: uuid.UUID, handbook_kb_id: uuid.UUID) -> list[ToolCreate]:
    """
    The three registry rows every demo workflow is built on.

    All three are registry-backed rather than inline on the node, and that is the
    demonstration: a node may override only `query`/`query_fields` and
    `payload`/`payload_fields` (`ToolService.NODE_OVERRIDABLE_KEYS`), so the
    corpus, the retrieval depth, the score floor, the ERP action and — above all
    — `is_mutating` are owned here and cannot be edited away on the canvas.

    `workspace_id` is filled in by the caller.
    """
    return [
        ToolCreate(
            workspace_id=uuid.uuid4(),  # replaced below
            name="finance_policy_search",
            tool_type="knowledge_search",
            description=(
                "Search the company's accounts payable policy, employee expense policy and signed supplier "
                "agreements. Use it to find the clause that governs a specific invoice or expense claim."
            ),
            is_mutating=False,
            config={
                "knowledge_base_id": str(finance_kb_id),
                # 8, not the default 5. Measured, not guessed: at 5 the expense
                # claim's retrieval returned the policy's receipt rule (§3) and
                # missed the alcohol cap (§7) and the non-reimbursable list (§8),
                # so the assessment named one breach out of three. The claim
                # still routed to the gate — one breach is enough to make
                # `compliant` false — but a review that lists one of three
                # problems is a worse demonstration than one that lists three.
                # Costs ~1,300 extra input tokens per call, about $0.0005.
                "top_k": 8,
                "score_floor": 0.3,
                # A registry knowledge_search row must carry a default query:
                # `_knowledge_search_config` refuses a config with neither
                # `query` nor `query_fields`, and the fields live on the node.
                "query": "What approval is required before this invoice can be paid?",
            },
        ),
        ToolCreate(
            workspace_id=uuid.uuid4(),
            name="handbook_search",
            tool_type="knowledge_search",
            description="Search the employee handbook for the company's own HR policy: leave, notice, pay, working patterns.",
            is_mutating=False,
            config={
                "knowledge_base_id": str(handbook_kb_id),
                "top_k": 4,
                "score_floor": 0.3,
                "query": "What is the annual leave entitlement?",
            },
        ),
        ToolCreate(
            workspace_id=uuid.uuid4(),
            name="hr_notify_employee",
            tool_type="notify",
            description="Tell an employee and their team the outcome of a request. In-app; no external transport.",
            # `notify` rejects is_mutating outright: a notification changes no
            # external record, and Vol. 5 puts Notify AFTER the gate — accepting
            # the flag would demand a second approval to tell someone the first
            # one happened.
            is_mutating=False,
            config={
                # `in_app`, not `webhook`, because the seed must run end to end
                # on a laptop with no Slack workspace behind it. Point this at an
                # incoming-webhook URL (channel `webhook`, `url` on the registry
                # row, its token in the tool's `secrets`) and every graph using
                # it starts posting to Slack with no node edited — which is the
                # registry-owns-the-transport rule paying off.
                "channel": "in_app",
                "title": "Request processed",
                "body": "A workflow completed and this is its outcome.",
            },
        ),
        ToolCreate(
            workspace_id=uuid.uuid4(),
            name="erp_create_journal_entry",
            tool_type="erp_connector",
            description="Create a journal entry in the general ledger. Writes to the finance system.",
            # THE flag. Publishing any graph that reaches this tool without a
            # human_approval node upstream is a 422 naming the node — see
            # validate_mutating_approval. Both mutating demo workflows depend on
            # it being true here, and a node cannot downgrade it.
            is_mutating=True,
            config={"action": "create_journal_entry"},
        ),
    ]


async def _ensure_tools(db: AsyncSession, target: SeedTarget, kbs: dict[str, KnowledgeBase]) -> dict[str, uuid.UUID]:
    service = ToolService(db)
    existing = {t.name: t for t in await service.list_tools(target.organization_id, target.workspace_id, None, None, 200)}

    resolved: dict[str, uuid.UUID] = {}
    for spec in _tool_specs(kbs[FINANCE_KB].id, kbs[HANDBOOK_KB].id):
        spec = spec.model_copy(update={"workspace_id": target.workspace_id})
        current = existing.get(spec.name)
        if current is None:
            tool = await service.create_tool(target.organization_id, spec)
            await db.commit()
            _done(f"tool '{spec.name}' registered ({spec.tool_type}{', MUTATING' if spec.is_mutating else ''})")
            resolved[spec.name] = tool.id
            continue

        # Reuse the row, but re-apply config/description — a re-run after an edit
        # here should change the registry, and `tool_type` is create-only so this
        # can never be a type change. `ToolUpdate` forbids unknown fields, which
        # is why only these three are sent.
        if (current.config or {}) != (spec.config or {}) or current.description != spec.description or current.is_mutating != spec.is_mutating:
            await service.update_tool(
                target.organization_id,
                current.id,
                ToolUpdate(description=spec.description, config=spec.config, is_mutating=spec.is_mutating),
            )
            await db.commit()
            _done(f"tool '{spec.name}' updated")
        else:
            _step(f"tool '{spec.name}' already registered")
        resolved[spec.name] = current.id

    return resolved


# ---------------------------------------------------------------------------
# Workflows
# ---------------------------------------------------------------------------


def _graph_signature(nodes: list[NodeInput], edges: list[EdgeInput]) -> str:
    """
    A stable fingerprint of a graph, used to decide whether to republish.

    Sorted and JSON-serialised so it does not depend on the order the database
    returns rows in — the same reason `graphSignature()` on the frontend is
    order-independent. Positions are included: moving a node on the canvas is a
    real change to what the next person opening the Builder sees.
    """
    payload = {
        "nodes": sorted(
            (
                {
                    "node_key": n.node_key,
                    "node_type": n.node_type.value if hasattr(n.node_type, "value") else str(n.node_type),
                    "config": n.config or {},
                    "position_x": n.position_x,
                    "position_y": n.position_y,
                }
                for n in nodes
            ),
            key=lambda n: n["node_key"],
        ),
        "edges": sorted(
            (
                {
                    "source_node_key": e.source_node_key,
                    "target_node_key": e.target_node_key,
                    "condition": e.condition,
                }
                for e in edges
            ),
            key=lambda e: (e["source_node_key"], e["target_node_key"], json.dumps(e["condition"], sort_keys=True)),
        ),
    }
    return json.dumps(payload, sort_keys=True, default=str)


def _to_inputs(spec: DemoWorkflow) -> tuple[list[NodeInput], list[EdgeInput]]:
    nodes = [
        NodeInput(
            node_key=n.node_key,
            node_type=n.node_type,
            config=n.config,
            position_x=n.position_x,
            position_y=n.position_y,
        )
        for n in spec.nodes
    ]
    edges = [EdgeInput(source_node_key=e.source_node_key, target_node_key=e.target_node_key, condition=e.condition) for e in spec.edges]
    return nodes, edges


async def _ensure_workflow(db: AsyncSession, target: SeedTarget, spec: DemoWorkflow) -> tuple[uuid.UUID, bool]:
    """
    Create-or-reuse the workflow shell, then publish the graph if it has changed.

    Returns `(workflow_id, published_now)`.
    """
    service = WorkflowService(db)
    context = AuditContext.for_user(target.user_id)

    existing = await service.list_workflows(target.organization_id, target.workspace_id, None, None, 200)
    workflow = next((w for w in existing if w.name == spec.name), None)

    if workflow is None:
        workflow = await service.create_workflow(
            target.organization_id,
            WorkflowCreate(
                name=spec.name,
                description=spec.description,
                workspace_id=target.workspace_id,
                trigger_type=spec.trigger_type,
                trigger_config=spec.trigger_config,
            ),
        )
        await db.commit()
        _done(f"workflow '{spec.name}' created ({spec.trigger_type})")

    nodes, edges = _to_inputs(spec)
    desired = _graph_signature(nodes, edges)

    # A published version is immutable, so "already correct" has to be decided by
    # comparing what is published against what we want — not by whether the
    # workflow exists. Without this, every re-run publishes a byte-identical
    # version N+1 and the version history fills with noise.
    if workflow.current_version_id is not None:
        current = await service.get_version(target.organization_id, workflow.id, workflow.current_version_id)
        current_nodes = [
            NodeInput(node_key=n.node_key, node_type=n.node_type, config=n.config or {}, position_x=n.position_x or 0, position_y=n.position_y or 0)
            for n in current.nodes
        ]
        current_edges = [
            EdgeInput(source_node_key=e.source_node_key, target_node_key=e.target_node_key, condition=e.condition) for e in current.edges
        ]
        if _graph_signature(current_nodes, current_edges) == desired:
            _step(f"workflow '{spec.name}' is already published with this graph (v{current.version_number})")
            return workflow.id, False

    version = await service.save_draft(target.organization_id, workflow.id, WorkflowVersionCreate(nodes=nodes, edges=edges), target.user_id)
    await db.commit()

    published = await service.publish_version(target.organization_id, workflow.id, version.id, target.user_id, context)
    await db.commit()
    _done(f"workflow '{spec.name}' published as v{published.version_number}")
    return workflow.id, True


async def _ensure_webhook_secret(
    db: AsyncSession,
    target: SeedTarget,
    workflow_id: uuid.UUID,
    *,
    rotate: bool,
) -> str | None:
    """
    Return the plaintext signing secret, minting one if there is none.

    The secret is returned exactly once, at generation, and nothing can read it
    back afterwards (`has_webhook_secret` is a bare bool by design). So a
    workflow that already has one, on a machine with no state file, genuinely
    cannot be signed for without rotating — which is what `--rotate-webhook-secret`
    is for, and why this returns None rather than pretending.

    Rotation has no grace window: the previous secret stops verifying the moment
    this commits.
    """
    service = WorkflowService(db)
    workflow = await service.get_workflow(target.organization_id, workflow_id)

    if workflow.webhook_secret_encrypted and not rotate:
        return None

    minted = await service.rotate_webhook_secret(target.organization_id, workflow_id, AuditContext.for_user(target.user_id))
    await db.commit()
    _done("webhook signing secret minted" if not rotate else "webhook signing secret rotated (the previous one no longer verifies)")
    return minted.secret


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def _write_state(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    # Best effort: the file holds a live webhook signing secret, but some mounts
    # (and Windows) refuse chmod, and failing the whole seed over file
    # permissions on a developer machine would be worse than the loose mode.
    with contextlib.suppress(OSError):
        path.chmod(0o600)


async def _seed(email: str, state_file: Path, rotate_secret: bool) -> None:
    async with AsyncSessionLocal() as db:
        target = await _resolve_target(db, email)
        # Same constraint a request runs under. Two deliberate differences from
        # `get_db_session`'s version:
        #
        #   - `set_config(...)`, not `SET ... = :org`. `SET` is utility syntax
        #     and takes no bind parameters — asyncpg turns the value into `$1`
        #     and Postgres answers "syntax error at or near $1". `set_config` is
        #     an ordinary function call and parameterises normally. Never build
        #     this by string interpolation instead; it is an injection site.
        #   - the third argument is `false`, i.e. session-scoped rather than
        #     transaction-local. This script commits several times and a
        #     `SET LOCAL` would die with the first transaction.
        await db.execute(text("SELECT set_config('app.current_org_id', :org, false)"), {"org": str(target.organization_id)})

        _heading(f"Seeding org {target.organization_id} · workspace '{target.workspace_name}' · as {target.email}")

        _heading("Knowledge bases")
        kbs = await _ensure_knowledge_bases(db, target)
        await _upload_corpus(db, target, kbs)

        _heading("Ingestion (running on worker_documents)")
        await _wait_for_indexing([kb.id for kb in kbs.values()], target.organization_id)

        _heading("Tool registry")
        tools = await _ensure_tools(db, target, kbs)

        _heading("Workflows")
        specs = build_workflows(
            policy_tool_id=tools["finance_policy_search"],
            handbook_tool_id=tools["handbook_search"],
            erp_tool_id=tools["erp_create_journal_entry"],
            notify_tool_id=tools["hr_notify_employee"],
        )
        workflow_ids: dict[str, uuid.UUID] = {}
        for spec in specs:
            workflow_id, _ = await _ensure_workflow(db, target, spec)
            workflow_ids[spec.name] = workflow_id

        invoice_id = workflow_ids["Invoice approval"]
        secret = await _ensure_webhook_secret(db, target, invoice_id, rotate=rotate_secret)

    state: dict[str, Any] = {
        "organization_id": str(target.organization_id),
        "workspace_id": str(target.workspace_id),
        "invoice_workflow_id": str(invoice_id),
        "workflows": {name: str(wid) for name, wid in workflow_ids.items()},
    }
    if secret is not None:
        state["webhook_secret"] = secret
        _write_state(state_file, state)

    _heading("Done. What to do next:")
    for spec in specs:
        print(f"\n  {spec.name}", flush=True)
        print(f"    {spec.demo_hint}", flush=True)

    if secret is not None:
        print(f"\n  Webhook secret written to {state_file} (mode 600). send_invoice.py reads it from there.", flush=True)
    else:
        print(
            "\n  The invoice workflow already had a signing secret and it is not readable back.\n"
            "  Re-run with --rotate-webhook-secret to mint a fresh one for send_invoice.py.",
            flush=True,
        )

    print("\n  Sample payloads for the trigger-payload box:", flush=True)
    print(f"    Expense claim review → {json.dumps(SAMPLE_EXPENSE_PAYLOAD)}", flush=True)
    print(f"    HR policy assistant  → {json.dumps(SAMPLE_HR_PAYLOAD)}", flush=True)
    print(f"    Leave approval       → {json.dumps(SAMPLE_LEAVE_REQUEST_PAYLOAD)}", flush=True)
    print(f"    Invoice (webhook)    → {json.dumps(SAMPLE_INVOICE_PAYLOAD)}", flush=True)
    print("", flush=True)


async def _run(email: str, state_file: Path, rotate_secret: bool) -> None:
    """
    Own the engine's lifetime inside ONE event loop.

    Disposing from a second `asyncio.run()` is the exact trap
    `workers/async_bridge.py` exists to avoid, and it fires here for the same
    reason: asyncpg connections are bound to the loop that opened them, so a
    dispose driven by a different loop floods the exit with `Event loop is
    closed` and `attached to a different loop`. Noise rather than data loss —
    everything has committed by then — but it buries the script's own output,
    which on a seed script is the entire point of running it.
    """
    try:
        await _seed(email, state_file, rotate_secret)
    finally:
        await engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed the demo corpus, tool registry and flagship workflows.")
    parser.add_argument("--email", required=True, help="Email of an existing user; the org is resolved from their membership.")
    parser.add_argument(
        "--state-file", type=Path, default=DEFAULT_STATE_FILE, help=f"Where to write the webhook secret (default {DEFAULT_STATE_FILE})."
    )
    parser.add_argument(
        "--rotate-webhook-secret",
        action="store_true",
        help="Mint a new signing secret even if one exists. The old one stops verifying immediately.",
    )
    args = parser.parse_args()

    try:
        asyncio.run(_run(args.email, args.state_file, args.rotate_webhook_secret))
    except SeedError as exc:
        print(f"\nSeed failed: {exc}\n", file=sys.stderr, flush=True)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
