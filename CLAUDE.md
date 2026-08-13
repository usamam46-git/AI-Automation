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
  Tools registry + `tool_executions` audit trail landed 2026-08-08 — see the
  bullet below.
  Schedule + webhook triggers, the audit trail and the per-org run quota all
  landed 2026-08-09 (Vol. 2 §5, §667, §700) — see the bullets below.
  The home dashboard + `analytics` module landed 2026-08-10 — see the bullet below.
  **336 tests pass** (`poetry run pytest` from `apps/api/`, confirmed clean run
  2026-08-10: 250 + 24 schedule-trigger + 22 webhook-trigger + 16 audit-log
  + 13 run-quota + 11 analytics).
- Key files added: `src/workers/celery_app.py`, `src/workers/postgres_saver.py`,
  `src/workers/graph_tasks.py`, `src/modules/executions/{schemas,repository,service,router}.py`.
  Migration: `alembic/versions/20260802_execution_engine.py` (interrupt_payload column).
- PostgresSaver design note: `aput_writes` uses an atomic single-statement JSONB
  append (no read-modify-write) to avoid a race with LangGraph's AsyncBackgroundExecutor
  which submits `aput` and `aput_writes` as concurrent asyncio tasks.
- `organizations` module has DB models only (no service/router). `executions` module
  is now fully implemented.
- LLM layer: `src/core/llm_client.py` is the single OpenAI wrapper (retries/backoff,
  cost calculation, token counting, LangSmith hook) for **both** completions
  (`parse()`) and embeddings (`embed()`, added 2026-08-12 — see the bullet below).
  Its `_MODEL_PRICING` and `_EMBEDDING_MODELS` tables are
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
- **Execution Viewer landed 2026-08-07** (Vol. 3 §6) — the loop is closed end to end:
  register → build on the canvas → publish → **Run now** → watch it pause → approve →
  completed, never touching the API or a DB row. Verified in a browser, both paths
  (approve → `completed`, reject → `rejected`).
  Backend: `GET /api/v1/executions` added to the EXISTING `modules/executions/` files —
  org-scoped, cursor-paginated on the same raw-ISO-`created_at` convention as the
  Workflows list (bare array, no envelope), filterable by `workflow_id` + `status`,
  `execution:read`. New lighter `WorkflowRunSummary`; `WorkflowRunResponse` gained
  `workflow_id`/`workflow_name`/`version_number` (model `@property`s + an eager-load in
  `get_run`) because the run only stores `workflow_version_id` and both the §6.1 header
  and the timeline's icon lookup need the workflow.
  Frontend: `app/(dashboard)/executions/{page,[runId]/page}.tsx`,
  `components/executions/*`, `lib/{run-status,run-timeline}.ts`, "Run now" on the
  workflows row menu + detail dialog, Executions nav entry. Live status is **polling**
  (~2.5s detail / 10s list, stops on terminal) — no WebSocket; that infra still
  doesn't exist. Three contracts in apps/web/CLAUDE.md: the version fetch is
  mandatory for node icons and pending rows, `interrupt_payload` has no prompt text,
  and `current_node_key` is unreliable for highlighting.
  **188 backend tests** (181 + 7 new) and **65 frontend tests** (32 + 33 new).
- **Three pre-existing Celery-worker bugs fixed 2026-08-07** while proving the loop.
  The worker had never run a task from the broker: empty task registry (no `include`),
  unregistered SQLAlchemy mappers (new `src/db/all_models.py`), and a stale asyncpg
  connection pool across per-task event loops (new `_run_async` in `graph_tasks.py`).
  Details in apps/api/CLAUDE.md — do not undo any of the three.
- **Local environment stood up on a Mac for the first time 2026-08-08** (previous
  work was on Windows). Four real gaps found and fixed, none of them OS-specific
  quirks — all four were present in the repo as committed:
  - `apps/api/Dockerfile` was **0 bytes** since the initial commit — `docker compose
    up` could never have built the `api`/`worker_*`/`beat` services. Written per the
    exact contract in Vol. 2 §16 (`python:3.12-slim`, `poetry install --no-root
    --only main`, `POETRY_VIRTUALENVS_CREATE=false` so the blueprint's bare `CMD
    ["uvicorn", ...]` resolves without a `poetry run` wrapper).
  - `poetry.lock`'s `greenlet` entry carries SQLAlchemy's own upstream marker —
    `platform_machine == "aarch64" | "ppc64le" | "x86_64" | "amd64" | "AMD64" |
    "win32" | "WIN32"` — which omits `"arm64"`, the exact string Apple Silicon
    reports. `poetry lock` regenerates this identically (it's not a stale-lock
    issue), so **every M-series Mac silently loses greenlet** and SQLAlchemy's
    async bridge breaks at runtime. Fixed at the source: `greenlet = "^3.5.4"`
    added as a direct dependency in `pyproject.toml`, which drops the inherited
    marker. Verified with a from-scratch `poetry install` (no manual `pip install`
    patch) plus a full 188-test pass.
  - `infra/docker-compose.yml`'s `api`/`worker_*`/`beat` services never set
    `JWT_SECRET_KEY` or `INTEGRATION_ENCRYPTION_KEY` (both `Field(...)` — required,
    no default in `core/config.py`) — every container would have crashed on boot
    with a pydantic `ValidationError`. `worker_documents` was also missing
    `CELERY_BROKER_URL`, defaulting to `redis://localhost:6379/1` inside its own
    container instead of the `redis` service. All five services now set all
    three, with the same dev-only-default convention already used for
    `SECRET_KEY` (`${VAR:-dev-default}` — override via `infra/.env` or the shell
    env for anything beyond a solo local machine). `api`'s `command:` also now
    passes `--reload` explicitly — the Dockerfile's `CMD` intentionally doesn't
    (matches the prod-facing Vol. 2 §16 excerpt verbatim), but this dev compose
    file bind-mounts `src/` specifically for hot-reload, so without the override
    the mount was silently inert.
  - Full stack (`docker compose up -d --build`, all 8 services) proven end-to-end:
    `api` container boots, migrates-and-seeds itself via `lifespan`, and answers
    `GET /api/docs` with 200 over the mapped port.
  - Test-DB/broker isolation was the one gap found here and **left open**; it was
    closed on 2026-08-08 — see the bullet below.
- **Test isolation closed 2026-08-08.** `apps/api/tests/conftest.py` now TRUNCATEs
  every `public` table except `alembic_version` around each test and stubs `.delay`
  on both Celery tasks. A full run now leaves `aap_db` with zero rows and sends the
  worker zero jobs (verified). The obvious transaction-rollback approach was tried
  and rejected for two concrete reasons — see apps/api/CLAUDE.md's testing section
  before re-attempting it. `testcontainers` (Vol. 7 §4) is still not wired up.
- **Tools registry landed 2026-08-08** (Vol. 2 §3.3/§7.2, Vol. 4 §4.1/§4.3) — the
  `tools` module went from models-only to real: `/api/v1/tools` CRUD, `is_mutating`
  promoted to a typed column, `tool_id` resolved against the registry once per run
  (the BYOK `client_factory` precedent), and `tool_executions` rows written
  **before** the call through a second synchronous engine (`src/db/sync_database.py`).
  Migration: `alembic/versions/20260808_tools_module.py`. Proven end to end against
  the live Docker stack: publishing a registry-mutating tool with no upstream
  approval 422s naming the node, deleting a tool referenced by a published version
  409s, and a `tool_id`-only node runs trigger → approve → completed through the
  real Celery worker leaving one `tool_executions` row with its `node_execution_id`
  back-filled and no headers or query strings in `input`.
  Five contracts in apps/api/CLAUDE.md's tools section; the two most load-bearing:
  inline `tool_type` config **always** wins over `tool_id`, and a node may override
  only per-usage state wiring, never the registry's `url`/`method`/`headers`/
  `action`/`is_mutating`. Agent function-calling (ReAct) is explicitly deferred —
  `function_specs()` is built and tested, the loop is not, and the reasons are
  written down.
- **Settings page + BYOK UI landed 2026-08-08** — `apps/web/app/(dashboard)/settings/`
  and `components/settings/openai-key-card.tsx` finally consume the integrations
  endpoints that had been complete and unused since 2026-08-06. Set/replace/remove
  with a masked `last_four`, 404 rendered as the empty state, 403 as an Owner-only
  locked card. **65 frontend tests still pass**; `npm run build`, `tsc --noEmit`
  and `eslint` clean (all four re-verified 2026-08-09 after the trigger UI
  landed — the new surfaces are `lib/`-free, so the vitest count is unchanged
  by design, not by omission).
- **Schedule + webhook triggers landed 2026-08-09** (Vol. 2 §5) — `trigger_type`
  went from decorative to real. Until this, the column shipped in the initial
  schema, the create dialog offered all five values, and **no code read it**;
  only `manual` did anything and the `beat` container booted with an empty
  schedule. Now: one beat entry (`dispatch-due-schedules`, 60s) enqueues
  `src/workers/trigger_tasks.py`'s tick, which polls `workflows.next_run_at` —
  the DB is the schedule, beat never learns about individual workflows. Webhooks
  arrive at `POST /api/v1/triggers/workflows/{id}`, the only unauthenticated
  route, authorized by HMAC-SHA256 over `"{timestamp}.{raw body}"`. Migration:
  `alembic/versions/20260809_workflow_triggers.py` (`next_run_at`,
  `last_triggered_at`, `webhook_secret_encrypted` + a partial index).
  Frontend: cron input in `workflow-dialog.tsx`, new
  `components/workflows/webhook-secret-card.tsx`, `email`/`event` removed from
  the dropdown (the API now 422s them).
  Proven end to end against the live Docker stack: beat fired the tick, the
  real worker ran a cron-triggered workflow to `completed` and re-armed
  `next_run_at` to the next boundary; a signed webhook returned 202 and
  completed with the right payload, while forged / unknown-workflow / stale
  requests all returned one byte-identical 401 and the secret sat encrypted in
  the column.
  Six contracts in apps/api/CLAUDE.md's triggers section; the three most
  load-bearing: **catch-up is deliberately suppressed** (an overdue workflow
  fires once, never replays the backlog), the **uniform 401 is anti-enumeration**
  and must not be made more helpful, and the webhook secret is **encrypted, not
  hashed** — the old `models.py` docstring specifying a hash was never
  implementable, since HMAC verification is symmetric.
- **Audit trail + per-org run quota landed 2026-08-09** (Vol. 2 §667, §700),
  closing the two gaps found earlier the same day. Both were "documented but
  absent": `audit_logs` had never been written to and its docstring falsely
  claimed a Postgres immutability trigger existed "in the initial migration"
  (there was no `CREATE TRIGGER` anywhere), and §667's run quota had no code
  despite `core/cache.py`'s `rate_limit_*` helpers being written and unused.
  - `audit_logs` module went models-only → real: `{schemas,repository,service,
    router}.py`, `GET /api/v1/audit-logs` (**read-only forever** — a test
    asserts 405 on POST/PATCH/PUT/DELETE), and migration
    `20260809_audit_log_immutability` adding `reject_audit_log_mutation()` plus
    BEFORE UPDATE/DELETE triggers. Eight material actions now write rows:
    publish, archive, run-started (×3 trigger paths), approve, reject, BYOK
    credential set/delete, webhook-secret rotation, quota-exceeded.
  - Quota: `consume_run_quota()` in `core/cache.py`, `DAILY_RUN_QUOTA_PER_ORG`
    (default 1000), 429 on the HTTP paths, skip-and-audit on the schedule tick.
    Added to all five app services in `infra/docker-compose.yml`.
  - **Also fixed a real pre-existing permission hole**: Viewer's `"*:read"`
    granted *every* `:read`, including the Owner-only `integration:read` and
    `billing:read`. `WILDCARD_READ_EXEMPT` in `core/permissions.py` closes it.
  - Proven live: raw `UPDATE`/`DELETE` on `audit_logs` both rejected by Postgres
    (and org hard-delete now fails, the documented cascade consequence), the
    trail rendered actor + IP + `last_four` with no full key anywhere, and a
    quota of 2 gave 201, 201, 429, 429 with exactly 2 runs created.
  - Full detail — including two ORM identity-map traps found writing it — is in
    apps/api/CLAUDE.md's audit-trail and quota sections.
- **Home dashboard + `analytics` module landed 2026-08-10** (Vol. 3 §5.1, the
  last missing core product surface). Backend: `analytics` went from an empty
  `.gitkeep` stub to real — `{schemas,repository,service,router}.py` and
  `GET /api/v1/analytics/dashboard`, returning the four stat cards from ONE query
  with five `COUNT(*) FILTER` aggregates. No migration and **no `models.py`** (it
  owns no tables — the one deliberate break from the five-file convention).
  Gated on `execution:read`, not a new permission: every figure is a roll-up of
  data that permission already exposes per-run.
  Frontend: `app/(dashboard)/dashboard/page.tsx`, `components/dashboard/
  {stat-card,recent-executions,workflow-tiles}.tsx`, pure `lib/dashboard-stats.ts`.
  The page lives at `/dashboard`, **not** `/` — Vol. 3 §1.1 gives `/` to the
  marketing landing and Next.js errors on two route groups claiming one path, so
  `app/page.tsx` stays a redirect placeholder for tomorrow's marketing work.
  Login and register now land on `/dashboard` instead of `/workflows`.
  Two decisions worth not re-litigating, both in apps/api/CLAUDE.md's analytics
  section: the success-rate denominator **excludes `rejected`/`cancelled`** (a
  rejected run is the Vol. 4 §4.3 gate working, and counting it as failure would
  punish orgs for reviewing carefully), and `success_rate` is **null, never 0.0**,
  when nothing has finished.
  Proven end to end against the live Docker stack: three runs triggered through
  the real Celery worker to `waiting_approval`, then one approved + one rejected
  gave `success_rate: 1.0` with `sample_size: 1` — the rejected run excluded.
  Verified in a browser in **both themes**, plus the fresh-org empty state
  rendering "—" rather than "0%".
  **336 backend tests** (325 + 11) and **87 frontend tests** (65 + 22).
- **Marketing landing page landed 2026-08-11** (Vol. 3 §1.1, the last placeholder
  route). `app/(marketing)/{layout,page}.tsx` + `components/marketing/*` (16
  components), `app/api/contact/route.ts`, and two pure vitest-covered modules
  `lib/{run-film,contact-form}.ts`. **`app/page.tsx` was deleted** — it was the
  placeholder redirect its own docstring said the landing would replace, and
  Next errors when two route groups claim `/`. `/dashboard` is unchanged.
  New deps: `gsap` (+ScrollTrigger), `@number-flow/react`, `canvas-confetti`;
  new `components/ui/{interactive-hover-button,accordion}.tsx`.
  Design: macOS-light, sky-gradient hero with a floating card collage, lime CTA,
  locked to light via a `.mk-root` token override (the app keeps both themes).
  The hero backdrop carries a **neon aurora rendered as a raw WebGL fragment
  shader** (`components/marketing/aurora-canvas.tsx`) — deliberately not
  three.js/R3F, which are installed but would add ~160KB gzipped to LCP for one
  quad. It is additive light under white text, so its envelopes are a contrast
  constraint: measured composite is 5.76 / 4.97 / 4.66:1 for eyebrow / headline
  / subhead. Re-measure if you retune it; the method is in apps/web/CLAUDE.md.
  It degrades to the plain CSS sky on no-WebGL, lost context or compile failure.
  The signature element is a **scroll-scrubbed run film** that plays one real
  execution — webhook → agent → condition → `human_approval` → tool → completed —
  and holds on the approval gate, because `validate_mutating_approval` is the
  product's actual differentiator and the page is built entirely around it.
  Verified in a browser section by section on desktop; **mobile is explicitly
  unverified** (Chrome zoomed instead of reflowing under automation, so no
  breakpoint was exercised).
  Three traps worth not rediscovering, all detailed in apps/web/CLAUDE.md: every
  `gsap.from(opacity: 0)` MUST be guarded by `runWhenVisible` (rAF is dead in a
  background tab, so the page blanked itself and froze — observed live, not
  theorised); Tailwind's `scale-*`/`translate-*` are `transform` and GSAP
  overwrites them; and NumberFlow's `style: "currency"` renders "US$49", the
  same locale trap already documented for `formatMonthlyCost`.
  The contact endpoint returns 503 until `CONTACT_WEBHOOK_URL` is set —
  deliberately loud, so submissions are never silently dropped.
  **114 frontend tests** (87 + 14 run-film + 13 contact-form).
- **Embedding client landed 2026-08-12** (Vol. 2 §3.4 / Vol. 4 §7 groundwork, the
  first RAG-facing code). `LLMClient.embed()` + `_EMBEDDING_MODELS` +
  `EMBEDDING_COLUMN_DIMENSIONS` in `src/core/llm_client.py`. **No migration, no
  new module, no tests, and nothing calls it yet** — `knowledge_base` is still
  models-only, and this was written with Docker down and no API key, so `embed()`
  has never run against the live endpoint. Treat it as unproven.
  It exists because the schema carried a real discrepancy:
  `knowledge_bases.embedding_model` defaults to `text-embedding-3-large`, which
  is natively **3072**-dimensional, while `document_chunks.embedding` and
  `agent_memory.embedding` are both `Vector(1536)` — and two docstrings asserted
  1536 *was* -large's native width. Resolved by requesting 1536 via the API's
  `dimensions` parameter (Matryoshka truncation, which the 3-series supports
  natively), keeping -large's retrieval quality at -small's storage and index
  cost with no migration. All three misleading comments corrected in
  `knowledge_base/models.py` and `agents/models.py` — **and in the blueprint
  itself**, Vol. 4 §9, which is where the error originated and which every other
  copy inherited it from. Vol. 2 §3.4's tables were already correct (they specify
  the column width and the model separately, never claiming the two match).
  Three contracts in apps/api/CLAUDE.md's embeddings section; the load-bearing
  ones: **`dimensions` is resolved from the model map and is never a call-site
  argument**, `embedding_spec_for()` **fails closed** on an unknown model (unlike
  `_pricing_for()`, which warns and falls back — a wrong price is reconcilable, a
  wrong dimension corrupts the shared HNSW index), and `embed()` takes a
  **required** `model` with no settings default, because embedding a query with a
  different model than its corpus produces plausible numbers and meaningless
  rankings without raising anywhere.
- **Tools registry UI + Builder registry picker landed 2026-08-12** — frontend
  only, **no backend change**: `/api/v1/tools` had been complete since
  2026-08-08 with *zero* consumers in `apps/web`. New
  `app/(dashboard)/tools/page.tsx`, `components/tools/{tool-dialog,
  delete-tool-dialog}.tsx`, `toolsApi` in `lib/api.ts`, a Tools nav entry and a
  `mutating` badge variant. The dialog deliberately edits only the fields a node
  cannot override, and offers no `input_schema` editor (function-calling is
  still deferred, so nothing would read it).
  The Builder's `tool-config-form.tsx` gained a **Registry / Inline source
  selector**. The two are mutually exclusive because inline `tool_type` always
  wins over `tool_id` at the backend, so switching clears the other path's keys;
  in registry mode only `NODE_OVERRIDABLE_KEYS` are editable and the rest render
  read-only off the registry row.
  This **closed the documented `graph-validation.ts` under-reporting
  divergence**: `validateGraph` now takes an optional `ToolRegistry`, the
  mutating walk ORs the registry flag in (upgrade-only, never downgrade), and a
  new eighth rule `unknown_tool` mirrors `_resolve_registry_tools`' FK check.
  Passing `undefined` (not loaded) vs an empty Map (nothing resolves) is
  load-bearing — see apps/web/CLAUDE.md.
  Verified in a browser in **both themes** against the live Docker stack:
  registering a mutating tool and selecting it on a node raised the approval
  warning on the canvas *with the node's own `is_mutating` unset* — the exact
  case that used to validate clean and then 422 at publish — and soft-deleting
  that tool turned the node's error into `unknown_tool`. One real bug was found
  that way and fixed: `sourceOf` tested `tool_id` for truthiness, so switching to
  registry mode (which writes `tool_id: ""`) re-rendered the inline fields under
  a registry toggle.
  **123 frontend tests** (114 + 9); `npm run build`, `tsc --noEmit` and `eslint`
  clean.
- **3D landing scene — all 5 phases done 2026-08-13** (Vol. 3 §1.1, frontend
  only, no backend change). A four-scene scroll-scrubbed WebGL narrative that
  **replaced both the sky-gradient hero and `run-film.tsx`**. It is now the
  landing page's **opening**: first paint is an office — a wall, a floor and a
  desk with this company's paperwork on it — with the hero headline above and
  the calls to action sitting on the desk. Scrolling lifts the documents off the
  surface and the narrative runs from there: scattered
  back-office documents → the core connects them → one real run holding at the
  approval gate → HR/ERP/Finance orchestrated, collapsing into the Orkest mark.
  The desk opening is load-bearing rather than decorative: it gives the sequence
  a physical starting point a viewer already recognises, so the airborne field
  reads as this company's work in the air rather than as objects that were
  always floating.
  It is **wired into `app/(marketing)/page.tsx` and verified in a browser at
  every scene**. Deleted with it: `components/marketing/{run-film,run-inspector,
  hero,sky-backdrop,aurora-canvas,hero-collage}.tsx` and the throwaway route
  `app/(marketing)/lab/`. The hero's words survive unchanged in
  `components/marketing/hero-copy.tsx`, over the room — and they stay
  **server-rendered**, outside the `ssr: false` scene import, so the H1 is in
  the initial HTML and a WebGL canvas never becomes the LCP element.
  **The first attempt at Phase 1 was rejected on sight and rebuilt** — worth
  knowing before touching it. It rendered abstract octahedrons/boxes/rings in an
  indigo-and-violet void with a glowing point-cloud core; the product owner's
  verdict was that it looked like every other AI landing page and said nothing
  about ERP/HR/Finance. The scene is a **daylight room**: near-white ground,
  white paper, near-black ink, nothing emissive — and every object is a
  **readable business document** drawn to a canvas texture. Do not reintroduce
  the dark palette or abstract the documents back into geometry; both paths have
  been walked.
  `lib/scene-script.ts` is the whole choreography and is pure — including real
  camera projection maths, so the composition is **asserted rather than
  eyeballed**. That was added after the first frame anyone looked at turned out
  to be wrong three ways at once (a hole through the middle, cards sliced by the
  frame edge, and an employee record sitting behind the headline). A spherical
  shell projects to an annulus; the distribution was the bug, not the seed.
  **`lib/run-film.ts` is kept and is now load-bearing**: scene 3 is its beat list
  mapped onto scroll rather than a second script, and its tested invariant that
  `post_to_erp` is still `pending` at the approval gate is rendered as a **visual
  fact** — at the hold, `JE-99120` shows no debit, no credit and no period, and
  is stamped NOT POSTED. The figures appear only once the gate clears.
  The ending collapses the graph into the Orkest mark, with the approval gates
  landing in the **open middle node** — the same held-open node
  `orkest-mark.tsx` uses for the human-approval step, and `MARK_NODES` is derived
  from that SVG's viewBox so the two cannot drift.
  `three` and `@react-three/fiber` were already in the tree and unused since the
  initial commit; they now have their first consumer. **No new dependency** —
  notably not `@react-three/postprocessing`.
  **The palette is macOS light mode and it is neutral** — `--mk-paper` is
  #f5f5f7 (the system light background macOS uses) and `--mk-mist` #ececef; the
  scene's gradient uses those same tokens rather than inventing its own.
  **The beige everyone kept seeing was the LIGHTS, not the palette**: the key
  light was `#fffaf2`, the fill `#fff4e6` and the hemisphere ground `#d8d3c9`,
  so every surface was multiplied by a warm light while every hex value in the
  source said neutral. If the room ever looks warm again, check the lights in
  `core-scene.tsx` first — chasing it through the colours found nothing, twice.
  **The desk is real polished walnut** (procedural grain in `wood-texture.ts`,
  clearcoat for the sheen), and it is the one warm thing in an otherwise neutral
  room. An earlier pass argued against wood and built a grey desk; white paper
  on a near-white desk washed out completely, and the timber is what finally
  makes the documents read.
  Two silent-failure traps stay documented in apps/web/CLAUDE.md: **R3F does not
  keep a `uniforms` object by reference**, and **shader `precision` must be
  declared in both stages**. Neither can currently fire — **there is no custom
  shader left in the scene**; the core, edges and mark are stock
  `meshStandardMaterial` driven by transforms and instanced matrices, which was
  cheaper and more correct than the shader version.
  **228 frontend tests** (95 over `scene-script` alone); `tsc --noEmit`,
  `eslint` and `npm run build` clean.
  **Still unverified: any real mobile viewport** (Chrome zooms rather than
  reflows under automation here, so no breakpoint was exercised — the
  composition rules compose for desktop aspects 1.6–2.4 and a phone likely needs
  its own depth schedule), and real-time motion/performance on integrated
  graphics.
- Next: verify the 3D scene on a real mobile viewport (the one thing it has
  never been seen on — see apps/web/CLAUDE.md), wire `embed()` into a real
  ingestion pipeline (the `knowledge_base`
  module is still models-only — chunking, OCR, and hybrid search are all unbuilt),
  `subgraph` handler, agent function-calling/ReAct (see the deferral note in
  apps/api/CLAUDE.md), and
  an audit-log viewer UI (the endpoint exists and nothing consumes it — same shape
  as the integrations endpoints before the Settings page).
  Still empty registries: the `worker_documents` and `worker_notifications`
  containers (nothing routes to their queues yet).
- Frontend: initial Next.js/shadcn shell done (auth, dashboard shell,
  workspaces, workflows list), the builder canvas, the Execution Viewer, the
  home dashboard, the tools registry, and the marketing landing page (see
  above). `app/(marketing)/` now exists and owns `/`; `app/page.tsx` is gone.
  `apps/web` DOES have test infrastructure — `vitest.config.mts`,
  `npm test`, 123 tests over the pure `lib/` modules only (no React harness;
  canvas and page rendering are manual-verification by design).

Verification note: confirm `apps/api/CLAUDE.md` is actually named with
that exact casing (not `claude.md`) — a lowercase filename will silently
fail to auto-load as an always-applied rule file. Run `/context` in a
fresh session to confirm all three CLAUDE.md files (root, apps/api,
apps/web) actually loaded before trusting this status section.