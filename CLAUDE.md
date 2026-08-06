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
  tokens_prompt/tokens_completion/cost_usd.
  Real `tool_handler` + the mutating-tool approval guardrail landed 2026-08-04
  (Vol. 2 §7.2, Vol. 4 §4.3) — see the two bullets below.
  BYOK OpenAI keys landed 2026-08-06 (Vol. 2 §13) — see the bullet below.
  Draft/publish validation split landed 2026-08-06 as Phase 0 of the Builder
  canvas work — see the bullet below.
  **181 tests pass** (`poetry run pytest` from `apps/api/`, confirmed clean run
  2026-08-06: 156 + 14 BYOK + 11 validation-split).
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
  change. `agent_handler` reads inline node config; `subgraph` remains a stub.
  Cost columns widened to `Numeric(12,6)` (migration `20260803_widen_cost_precision`).
- Tool layer (2026-08-04, Vol. 2 §7.2): `tool_handler` in `src/graphs/node_handlers.py`
  is real for two of the four blueprint tool types — `http_request` (outbound httpx
  call, retry shape copied from `LLMClient._call_with_retry`) and a mock
  `erp_connector` (no network call, returns `MOCK-<uuid>` confirmations).
  `python_function`/`mcp` are rejected by name. Config is inline on the node, same
  denormalization as agent nodes. Tool nodes get `node_executions` rows for free via
  the existing generic `_stream_graph` loop and leave tokens/cost NULL by emitting no
  `node_usage`. `httpx` moved from dev-only to a runtime dependency.
- **Mutating-tool approval guardrail is ENFORCED** (Vol. 4 §4.3), no longer a
  documented target: `validate_mutating_approval()` in
  `src/modules/workflows/service.py`, called from `publish_version` only, 422 via
  `_raise_validation_error`, naming the offending node_keys. Three settled design
  points, all recorded in apps/api/CLAUDE.md's security section — **publish-only**
  (not save_draft, so half-built drafts still save), **∃-semantics** (flag only when
  zero approvals exist upstream; ∀ would reject Vol. 5 §1 and §5, the blueprint's own
  reference workflows), and **config-embedded `is_mutating`**, which is fail-open on
  a misspelled key. Do not restate the rule as stronger than it is.
- **BYOK OpenAI keys landed 2026-08-06** (Vol. 2 §13): `integrations` module is
  now real for one type, `openai_api_key` — `src/modules/integrations/
  {models,schemas,repository,service,router}.py`, `PUT/GET/DELETE
  /api/v1/integrations/{integration_type}`. AES-256-GCM at rest
  (`src/core/encryption.py`), key in `INTEGRATION_ENCRYPTION_KEY` (new secret,
  separate from `SECRET_KEY`/`JWT_SECRET_KEY`). Wired into execution: `graph_tasks.
  _resolve_llm_client_factory()` resolves the org's key once per run and binds it
  via `functools.partial(get_llm_client, api_key_override=...)`, threaded through
  `_compile_state_graph`/`_bind_node_handler`'s new `client_factory` param — no
  stored key means the pre-BYOK `settings.OPENAI_API_KEY` fallback is unchanged.
  `INTEGRATION_READ`/`INTEGRATION_WRITE` are Owner-only (not in Admin's
  `seed_roles.py` list), matching `BILLING_READ`/`BILLING_WRITE`. No live
  key-validation call to OpenAI at set-time (deliberate — see apps/api/CLAUDE.md
  security section); only a structural `sk-` prefix check. Migration:
  `alembic/versions/20260806_integration_creds.py`.
- **Draft/publish validation split landed 2026-08-06** (Phase 0 of the Builder canvas):
  `save_draft` now calls the new lenient `validate_draft_structure()` (duplicate
  `node_key` + edges referencing a missing key only); start/end presence, orphans and
  cycles are publish-only, joining `validate_mutating_approval` under the same rationale
  its docstring already gave. Required because the canvas autosaves mid-construction and
  every intermediate graph violates a shape rule. Also fixed a live **HTTP 500** in
  `validate_graph_structure`: `orphan_keys` was initialised inside the `for edge in edges`
  loop, so an edgeless graph (drop a start + an end, don't connect them yet) raised
  `UnboundLocalError`. See apps/api/CLAUDE.md's security section for the full rule.
- **Builder canvas landed 2026-08-06** (Vol. 3 §4) — all four phases, built by hand
  with shadcn/ui on the existing oklch tokens. The 21st.dev MCP was dropped: it is
  configured in `.mcp.json` but never authenticated, and nothing needed it.
  Route `apps/web/app/(dashboard)/workflows/[workflowId]/builder/page.tsx`;
  `lib/{node-catalog,graph-mapping,graph-validation,output-schema}.ts`;
  `hooks/use-workflow-autosave.ts`; `stores/workflow-builder-store.ts`;
  `components/workflow-builder/*` (canvas, toolbar, palette, node card, config panel
  and its five forms, three reusable editors, `builder.css`).
  Working end to end: drag/drop, connect, delete, per-type config forms, inline
  validation, 800ms debounced autosave, publish, and Test Run. Also enabled the
  previously-disabled "Open Builder" button and fixed the shell's nav active-match
  (`startsWith`) for nested routes.
  **32 frontend tests pass** (`npm test` from `apps/web/` — vitest over the pure `lib/`
  modules only; canvas interaction and theming are manual-verification by design).
  `npm run build`, `tsc --noEmit` and `eslint` are clean.
  **Not yet verified in a browser** — the canvas has not been seen rendering in either
  theme, and no workflow has been built through the UI end to end. That is the next
  thing to do, and the React Flow stock-CSS override is the specific risk.
  Three contracts to know before touching it, all detailed in apps/web/CLAUDE.md:
  React Flow node `id` **is** `node_key`; `lib/graph-validation.ts` duplicates all seven
  backend rules in TypeScript (∃-semantics on the mutating-approval walk — do not
  tighten to ∀); and the config forms construct the inline agent/tool shapes exactly as
  `_agent_config`/`_tool_config` accept them, so changing either side means changing both.
- Next: `subgraph` handler, real `tools` module (CRUD + `tool_executions` rows written
  *before* mutating calls, per Vol. 4 §4.3), Executions UI, and a Settings UI page for
  the BYOK endpoints above.
- Frontend: initial Next.js/shadcn shell done (auth, dashboard shell,
  workspaces, workflows list) plus the builder canvas scaffold (see above).
  Executions UI still intentionally deferred. `app/(marketing)/` referenced
  in apps/web/CLAUDE.md does not exist yet. `apps/web` has **no test
  infrastructure** — vitest for the pure `lib/` modules is proposed in the
  plan, not yet added.

Verification note: confirm `apps/api/CLAUDE.md` is actually named with
that exact casing (not `claude.md`) — a lowercase filename will silently
fail to auto-load as an always-applied rule file. Run `/context` in a
fresh session to confirm all three CLAUDE.md files (root, apps/api,
apps/web) actually loaded before trusting this status section.