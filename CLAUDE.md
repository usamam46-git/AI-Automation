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
  interrupt → approve/reject → completed/rejected. Execution engine phase fully
  closed out (permission test + status typing hardened 2026-08-03).
  LLMClient + real agent-node execution landed 2026-08-03 (Vol. 2 §8, Vol. 4 §6):
  agent nodes call OpenAI with structured outputs and persist real
  tokens_prompt/tokens_completion/cost_usd. All 100 tests pass.
- Key files added: `src/workers/celery_app.py`, `src/workers/postgres_saver.py`,
  `src/workers/graph_tasks.py`, `src/modules/executions/{schemas,repository,service,router}.py`.
  Migration: `alembic/versions/20260802_execution_engine.py` (interrupt_payload column).
- PostgresSaver design note: `aput_writes` uses an atomic single-statement JSONB
  append (no read-modify-write) to avoid a race with LangGraph's AsyncBackgroundExecutor
  which submits `aput` and `aput_writes` as concurrent asyncio tasks.
- `organizations` module has DB models only (no service/router). `executions` module
  is now fully implemented.
- LLM layer: `src/core/llm_client.py` is the single OpenAI wrapper (retries/backoff,
  cost calculation, token counting, LangSmith hook). Its `_MODEL_PRICING` table is
  hand-maintained — OpenAI has no pricing API, so re-verify rates on any pricing
  change. `agent_handler` reads inline node config; `tool`/`subgraph` remain stubs.
  Cost columns widened to `Numeric(12,6)` (migration `20260803_widen_cost_precision`).
- Next (tomorrow, committed scope): **mutating-tool approval lint rule**
  (Vol. 4 §4.3, cross-ref Vol. 2 §6.1). Reject publishing with 422 if any node
  with `is_mutating: true` in its config has no `human_approval` node anywhere in
  its upstream dependency path. Goes in the SAME validation layer as the existing
  structural checks — `GraphValidationError` in
  `src/modules/workflows/service.py`, surfaced as 422 by `_raise_validation_error`
  (service.py:226). Reuse the DFS in `_find_cycle` as the traversal model.
  See the "Mutating-tool approval lint" memory for the two open design points.
  This closes the gap now flagged in apps/api/CLAUDE.md's security section.
- Then: `tool`/`subgraph` handlers, BYOK via the integrations module (the
  `get_llm_client(api_key_override)` seam is already in place), then Builder canvas
  (React Flow) + Executions UI.
- Frontend: initial Next.js/shadcn shell done (auth, dashboard shell,
  workspaces, workflows list). Builder canvas (React Flow) and Executions
  UI intentionally deferred until the execution layer exists.
  `app/(marketing)/` referenced in apps/web/CLAUDE.md does not exist yet.

Verification note: confirm `apps/api/CLAUDE.md` is actually named with
that exact casing (not `claude.md`) — a lowercase filename will silently
fail to auto-load as an always-applied rule file. Run `/context` in a
fresh session to confirm all three CLAUDE.md files (root, apps/api,
apps/web) actually loaded before trusting this status section.