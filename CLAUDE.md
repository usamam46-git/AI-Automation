# AI Automation Platform — Root Instructions

Multi-tenant AI workflow automation SaaS. Monorepo: `apps/api` (FastAPI
backend), `apps/web` (Next.js frontend), `Docs/ERP HR Financial System
Automation Docs/` (the 7-volume engineering blueprint — the source of
truth for architecture decisions).

## Before any non-trivial change

Check the relevant blueprint volume in `Docs/ERP HR Financial System
Automation Docs/` first:
- Volume 1 — vision, tech stack rationale, repo structure
- Volume 2 — backend architecture, DB schema, LangGraph, security
- Volume 3 — frontend architecture, design system
- Volume 4 — AI engineering (LangGraph mechanics, RAG, evaluation)
- Volume 5 — ERP workflow specs
- Volume 6 — deployment/ops
- Volume 7 — roadmap, testing, cost

If a task isn't covered by the blueprint, say so explicitly rather than
inventing an approach that isn't documented anywhere.

## Directory discipline (read before creating any file or folder)

- Never create a new top-level directory under `apps/api/src/modules/`
  without explicit confirmation first. New functionality for an existing
  domain (e.g. workflow versions, nodes, edges) is added to the EXISTING
  module's files (`models.py`, `schemas.py`, `service.py`, `repository.py`,
  `router.py`), not a new module.
- Tests in `apps/api` live in the flat top-level `apps/api/tests/`
  directory (`test_<domain>.py`), NOT nested inside `src/modules/*/tests/`.
  Check `apps/api/tests/conftest.py` for existing fixtures before writing
  new ones.
- Before creating any new file or directory, state where it's going and
  why, and confirm it matches the structure already in the repo — don't
  assume, look first.

## Cross-cutting architectural rules

- **Layering**: router → service → repository → models. Routers contain
  only route decorators, dependency injection, and a call to the service —
  zero business logic, zero direct DB access.
- **organization_id provenance**: always from the authenticated context
  (`get_current_org`), NEVER from a request body, path param, or query
  param. Any schema with a client-settable `organization_id` field is a bug.
- **Tenant isolation**: tables without a direct `organization_id` column
  (e.g. workflow_versions, workflow_nodes, workflow_edges) must always be
  accessed by joining through their owning table. RLS is defense-in-depth,
  not a substitute for scoping at the query layer.
- **Versioning immutability**: once a `WorkflowVersion.published_at` is
  set, its nodes/edges are never mutated again by any code path. Reject
  with 409, don't silently allow.
- **Review-first workflow**: for any multi-file change, show the planned
  file list and any open design questions before implementing. Don't guess
  on ambiguous design decisions (e.g. permission scoping, schema shape) —
  ask.
- **No `eval()` or dynamic code execution** on any user-supplied data
  (e.g. workflow conditional-edge expressions) — use the structured
  condition DSL (`field`/`operator`/`value`) already established in
  `apps/api/src/graphs/condition_eval.py`.

## Current build status

(Keep this section updated daily — it's the fastest way for a fresh Claude
Code session to know where things stand without re-deriving it. Last
verified via a full read-only orientation pass — see note below.)

- Done: DB schema + RLS, Auth/RBAC, Workspaces + Workflow-shell CRUD,
  Workflow Versions/Nodes/Edges CRUD, Graph Compiler + Redis-backed LRU cache,
  Celery task queues + LangGraph execution engine + PostgresSaver checkpointer
  (Vol. 2 §5, §6.3–6.5). Full execution lifecycle: trigger → run → human_approval
  interrupt → approve/reject → completed/rejected. All 69 tests pass.
- Key files added: `src/workers/celery_app.py`, `src/workers/postgres_saver.py`,
  `src/workers/graph_tasks.py`, `src/modules/executions/{schemas,repository,service,router}.py`.
  Migration: `alembic/versions/20260802_execution_engine.py` (interrupt_payload column).
- PostgresSaver design note: `aput_writes` uses an atomic single-statement JSONB
  append (no read-modify-write) to avoid a race with LangGraph's AsyncBackgroundExecutor
  which submits `aput` and `aput_writes` as concurrent asyncio tasks.
- `organizations` module has DB models only (no service/router). `executions` module
  is now fully implemented.
- Next: Builder canvas (React Flow) in frontend + Executions UI, OR further backend
  features (webhook triggers, audit logs, billing stubs).
- Frontend: initial Next.js/shadcn shell done (auth, dashboard shell,
  workspaces, workflows list). Builder canvas (React Flow) and Executions
  UI intentionally deferred until the execution layer exists.
  `app/(marketing)/` referenced in apps/web/CLAUDE.md does not exist yet.

Verification note: confirm `apps/api/CLAUDE.md` is actually named with
that exact casing (not `claude.md`) — a lowercase filename will silently
fail to auto-load as an always-applied rule file. Run `/context` in a
fresh session to confirm all three CLAUDE.md files (root, apps/api,
apps/web) actually loaded before trusting this status section.