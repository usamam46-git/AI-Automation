# AI Automation Platform — Root Instructions

Multi-tenant AI workflow automation SaaS. Monorepo: `apps/api` (FastAPI
backend), `apps/web` (Next.js frontend), `Docs/ERP HR Financial System
Automation Docs/` (the 7-volume engineering blueprint — the source of
truth for architecture decisions).

## Current sprint — read this first

**`Docs/15-day-build-plan.md` is the active plan** (2026-08-14 → 2026-08-29).
It states what is being built, in what order, the architecture decisions already
settled, and the OpenAI budget model. Read it before proposing work on the
knowledge base, RAG, retrieval or the demo workflows — several approaches are
deliberately ruled out there with reasons, and re-deriving them wastes a day.

The headline: **`knowledge_base` is the one module to build.** MinIO, both vector
indexes on `document_chunks`, the `worker_documents` queue and `LLMClient.embed()`
are already provisioned and unused. Keep the plan's progress log at the bottom
updated as days complete.

## First run on a new machine — do this before storing any credential

```
cp infra/.env.example infra/.env    # then generate the three secrets it names
```

`infra/docker-compose.yml` writes every secret as `${VAR:-default}` and those
defaults are **committed to this repo**. The stack therefore boots on a fresh
clone with no setup, which is why it is easy to miss that until `infra/.env`
exists, `INTEGRATION_ENCRYPTION_KEY` is public — and that key is what encrypts
BYOK API keys and webhook signing secrets at rest. Left at the default,
"encrypted at rest" is obfuscation, not encryption.

**Do it before storing anything, not after.** AES-GCM authenticates, so rotating
the key does not degrade old ciphertext, it destroys it: every
`integrations.credentials` and `workflows.webhook_secret_encrypted` value
becomes permanently undecryptable and must be re-entered by hand.

This exact trap has now fired twice — once on Windows (day 1) and again on the
Mac (2026-08-16), because the first fix was recorded in `infra/.env` itself,
a gitignored file that cannot travel to the next machine. `infra/.env.example`
is committed precisely so the warning arrives with the clone.

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

## External systems — the honest line

**No real external system has ever been called by this platform.** Everything
below was proven against systems we control: a mock `erp_connector` returning
`MOCK-<uuid>`, our own signed webhook, our own MinIO, our own corpus. All of that
passes end to end, in a browser, through real Celery workers, without exercising
one third-party API — which is exactly why the gaps went unnoticed until someone
asked what pointing at a real ERP would take (2026-08-23).

Connecting to a real system today means an **`http_request` registry tool**.
`erp_connector` is a mock and is not that path. The full real/mock/missing table
lives in apps/api/CLAUDE.md; the one that bites hardest is that
`worker_notifications` still has an empty task registry and there is no `notify`
NodeType, so **every Vol. 5 HR workflow's terminal Notify step has no
implementation**.

Keep this section current. A feature list that reads as a victory lap while
"ERP" appears throughout is how three weeks of work leaves someone believing the
integration side is done.

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
  **469 tests pass** (2026-08-21; confirmed clean run in 84s against `aap_test`,
  with MINIO_ENDPOINT pointed at TEST-NET-3 to prove no object-storage dependency
  — the last full-suite figures were 467 on 2026-08-18 and 430 on 2026-08-17).
  Note on running them: `poetry` is not on PATH on every dev machine, and the
  api image installs `--only main`, so `poetry run pytest` from `apps/api/` is
  not universally available. The portable route is inside the container —
  `docker exec -w /app aap_api poetry install --no-root --with dev` once, then
  `docker exec -e PYTHONPATH=/app -w /app aap_api python -m pytest -q`. The dev
  deps do not survive a container rebuild; `tests/` is not in the image or the
  bind mounts, so `docker cp` it in (delete `/app/tests` first — `docker cp`
  into an existing directory nests it). **Then delete the copied
  `__pycache__`** — `docker exec aap_api sh -c 'find /app/tests -name __pycache__
  -type d -exec rm -rf {} +'`. The host's caches embed host absolute paths, and
  pytest-asyncio calls `inspect.getsource` during fixture setup, so without this
  the run reports `OSError: could not get source code` on almost every async test
  — 238 failures that look like a real breakage and are pure artifact (hit
  2026-08-21).
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
    `api` container boots, seeds system roles via `lifespan`, and answers
    `GET /api/docs` with 200 over the mapped port.
    **Corrected 2026-08-15 — this used to say "migrates-and-seeds itself", and
    the migrate half was never true.** `lifespan` in `src/main.py` does exactly
    two things: `init_redis()` and `seed_system_roles()`. Nothing ran
    `alembic upgrade head`, so on a *fresh volume* the api tried to seed into a
    schema-less database and died with `UndefinedTableError: relation "roles"
    does not exist` → `Application startup failed. Exiting.` — a crash loop on
    every first run, on every machine. It went unnoticed because a machine with
    an existing volume never hits it, and because this line claimed the
    container healed itself. Closed the same day by putting the migration in the
    `api` service's `command:` — see the bullet below.
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
- **The landing scene's opening room became a PHOTOGRAPH on 2026-08-14**
  (frontend only, no backend change). The modelled wall/floor/walnut desk is
  replaced by `apps/web/public/desk-room.jpg`, composited as a DOM plate *under*
  the transparent canvas by `components/marketing/scene/room-plate.tsx`. The
  documents are still real WebGL geometry on a real solved plane, now casting
  contact shadows onto an invisible `ShadowMaterial` catcher — `office-room.tsx`
  is gutted to that one plane and `wood-texture.ts` is deleted.
  The camera is **solved against the photograph, not eyeballed**: a luminance
  scan measures the table's far edge at NDC -0.4463, the opening camera is held
  exactly level (the plate has no keystoning), and six tests assert the match so
  the wood and the paper cannot drift apart. Two real bugs were found and fixed
  that way — an eyeballed `object-position` that left the documents floating
  above the table, and a card-to-catcher gap so small that every contact shadow
  landed underneath the card that cast it.
  Two settled rules were knowingly amended, both recorded in apps/web/CLAUDE.md
  with the reasoning: the key light is now **warm and from the left** for the
  plate's lifetime only (ramping to neutral by `LIFTOFF_END`, so scenes 2–4 are
  lit exactly as before), and the hero copy now carries a **measured** 45% wash
  plus near-opaque type — translucent ink has a contrast ceiling no background
  can lift, and it measured 1.0:1 over the photograph.
  The first plate the product owner supplied was 736×414 and sharp-everywhere;
  it was replaced mid-build with a 1000×661 shot whose background is
  **optically** out of focus, which is what makes the whole approach work.
  **241 frontend tests**; `tsc --noEmit`, `eslint` and `npm run build` clean, and
  verified in a browser at progress 0, 0.085, 0.22, 0.70 and 1.0.
- **Knowledge base + ingestion pipeline landed 2026-08-15** (Vol. 2 §3.4, days
  2-5 of the build plan). `knowledge_base` went models-only -> real:
  `/api/v1/knowledge-bases` with KB CRUD, multipart document upload, document
  list/detail/delete and a chunk reader. New `src/core/storage.py` (first code
  ever to touch MinIO) and `src/core/document_text.py` (extraction + chunking,
  pure). New `src/workers/document_tasks.py` — **the first task ever registered
  on `worker_documents`**, which had booted with an empty registry since the
  initial commit. Migration `20260815_kb_ingestion` adds `documents.content_hash`
  + `documents.error` and grants `knowledge:read`/`knowledge:write` to Admin and
  Editor. New deps: `pypdf`, `python-docx`, `tiktoken`.
  Proven end to end against the live stack: `curl -F file=@ap-policy.pdf` -> 202
  -> worker -> `indexed`, 1536-d vectors in `document_chunks`, chunks readable
  through the API. Re-uploading the same file returns **200** and spends nothing.
  Contracts in apps/api/CLAUDE.md's knowledge-base section; the load-bearing
  ones: dedup happens at **upload** (not just re-ingest, which was the first and
  wrong implementation), `document_chunks` has no tenant column so the join
  through `documents` is the only isolation, `passive_deletes=True` is required
  or deleting a KB raises NotNullViolation, and **workers do not bind-mount
  `src/`** so a new task module needs an image rebuild.
- **Retrieval + the `knowledge_search` tool landed 2026-08-16** (days 6–7).
  `knowledge_search` is a **tool type, not a node type** — it slots into the
  existing dispatcher and inherits the registry picker and `tool_executions`
  auditing, instead of touching the backend enum, the frontend node catalog, a
  config form and `lib/graph-validation.ts`. No migration: the HNSW index was
  already there.
  New: `build_chunk_search_stmt` in `knowledge_base/repository.py`,
  `KnowledgeBaseService.search()` (async) + `search_knowledge_base_sync()`
  (sync, for the node), `POST /api/v1/knowledge-bases/{id}/search`.
  **408 backend tests** (389 + 19).
  Proven live end to end: published `start → knowledge_search → agent → end`
  ran through the real Celery worker to `completed`, the tool node put a real
  chunk (cosine 0.5589) into graph state, and the agent answered from it and
  cited the document.
  Four contracts in apps/api/CLAUDE.md's retrieval section; the load-bearing
  ones: **ORDER BY is raw cosine distance, never `1 - distance` descending**
  (algebraically identical, and it silently defeats the HNSW index);
  `organization_id` comes from **graph state**, never node config; and
  `knowledge_search` **emits `node_usage`** while the other two tool types still
  do not — a deliberate, documented break with the old invariant.
- **Knowledge base UI landed 2026-08-16** (days 8–9, frontend). `/knowledge` list
  + `[kbId]` detail, `components/knowledge/*` (dropzone, document list, chunk
  inspector, retrieval playground), pure `lib/knowledge.ts`, `knowledgeApi` in
  `lib/api.ts`. Document status is **polled** and the interval stops the moment
  nothing is `uploaded`/`processing` — same decision as the Execution Viewer, and
  for the same reason (no WebSocket infra). The playground deliberately searches
  with `score_floor: 0` and draws the backend's 0.3 cutoff visually instead: it
  exists to calibrate that number, so it must show what the floor would discard.
  `knowledge_search` is wired into the builder's tool form **both ways** — inline,
  and registry, the latter reachable only because `components/tools/tool-dialog.tsx`
  gained the type on the same day. A registry retrieval row **must carry a default
  `query`** (`_knowledge_search_config` refuses a config with neither `query` nor
  `query_fields`), while the KB, `top_k` and `score_floor` stay registry-owned.
  Verified in a browser in both themes and proven end to end: a registry-backed
  `start → knowledge_search → end` published and ran through the real worker to
  `completed`, with the node's own question overriding the registry default.
  **260 frontend tests**; `tsc`, `eslint` and `npm run build` clean.
  Two bugs this pass found, both fixed and worth not reintroducing:
  **`knowledgeApi.upload` must name `multipart/form-data`** — the shared axios
  instance defaults to `application/json`, and axios's `transformRequest` reads
  that header first and JSON-serialises the FormData, so the file arrived as `{}`
  and every upload 422'd; and **`KnowledgeBaseService.search()` now resolves the
  org's BYOK key itself** (`_byok_client_factory`, the request-scoped twin of
  `graph_tasks._resolve_llm_client_factory`) — it was the one retrieval path that
  ignored a stored key, so the playground 500'd for any org without a server-wide
  `OPENAI_API_KEY`.
  Two gaps the pass opened were closed the same day, and both are contracts now:
  **deleting a KB is a 409 while anything still searches it** — a live registry
  `knowledge_search` tool (named in the message) or a node carrying
  `knowledge_base_id` inline in a *published* version, the same
  published-blocks/draft-doesn't asymmetry `ToolService.delete_tool` uses, with
  the 409 rendered in the dialog rather than as a toast; and **the workspace
  selection persists** (`persist` middleware, `localStorage`, key
  `orkest.workspace`), with `dashboard-shell.tsx` correcting a stored id that is
  not in the fetched list and logout clearing it.
- **Test suite now REFUSES to run outside a `*_test` database** (2026-08-15).
  Truncate-based isolation wipes whatever `DATABASE_URL` names, and on
  2026-08-15 a run against the dev database destroyed an org, a user, a
  published workflow and its run history — the only symptom being the next login
  failing with "system roles not seeded". `conftest.py` now hard-exits unless the
  DB name ends in `_test`; `AAP_ALLOW_DESTRUCTIVE_TESTS=1` overrides. See
  apps/api/CLAUDE.md for how to create and target `aap_test`.
- **Flagship demo workflows landed 2026-08-17** (days 10–12 — the plan's own gate
  passed live). New `apps/api/src/db/demo/`: four Markdown corpus documents
  (AP policy, the Acme Vendor MSA, expense policy, employee handbook), `graphs.py`
  holding three workflow graphs as pure data, an idempotent `seed.py`
  (`--email`-targeted, goes through the real services) and `send_invoice.py`
  which HMAC-signs and POSTs the demo invoice. It lives under `src/` because that
  is the only path `api` bind-mounts, so corpus and prompt edits need no rebuild.
  Two knowledge bases (Finance policies / Employee handbook) and three registry
  tools; only `erp_create_journal_entry` is mutating.
  Proven end to end against the live stack: signed webhook → extract →
  `knowledge_search` → validate → condition → **held at the gate** → approve →
  mock ERP write → `completed`, $0.002233, citing `ap-policy.md` §2 and the MSA,
  with `account_code: "5100"` read out of the policy's own coding table. The
  expense claim was routed to a human **by the retrieved policy** (`compliant:
  false`, receipt rule quoted, `reimbursable_amount` 700.55 — the landing page's
  own figure), and the HR assistant answered from the handbook in one leg on both
  its static query and a payload question. The guardrail was re-proven on this
  exact graph: removing `approval_1` makes publish a 422 naming `post_to_erp`.
  Frontend: **the approval sentence is now derived** (`lib/approval-summary.ts` —
  Vol. 3 §6.1's "Approve $4,200.00 to Acme Vendor LLC?", built from upstream node
  outputs, falling back to the generic headline when nothing can be derived; this
  is NOT licence to add a message field to `human_approval`), and **"Run now" now
  has a trigger-payload box** (`run-workflow-dialog.tsx` + `lib/trigger-payload.ts`),
  closing a gap open since day 1 — the API had always accepted `trigger_payload`
  and no UI ever sent one, which made two of the three demo workflows unrunnable
  from a browser.
  **430 backend tests** (+19 in `tests/test_demo_graphs.py`, which runs the demo
  graphs through the real validators with no DB) and **292 frontend tests** (+32).
  Total OpenAI spend for the whole phase was **under 2 cents** against a $1.50–2.50
  estimate. Contracts in apps/api/CLAUDE.md's demo-seed section and
  apps/web/CLAUDE.md's approval-sentence section; the load-bearing ones: the seed
  goes through **services not repositories**, `SET x = :param` is not
  parameterisable in Postgres (use `set_config()`), the async engine must be
  disposed **inside the same event loop**, and `approval-summary.ts` must **never
  invent** a figure it could not read.
- **Audit log viewer + portfolio surface landed 2026-08-18** (days 13–14). Three
  of the plan's five items; the other two need hardware and are still open —
  **the landing page has still never been seen on a real phone**, and the
  three-minute walkthrough is unrecorded.
  Backend: one field, `actor_email`, joined onto `AuditLogResponse` via a LEFT
  OUTER JOIN guarded on `actor_type = 'user'` (the column is polymorphic). No
  migration. `AuditService.list_logs` now returns response models rather than
  ORM rows as a consequence — see apps/api/CLAUDE.md's audit-trail section.
  Frontend: `app/(dashboard)/audit-log/page.tsx`,
  `components/audit-log/audit-log-row.tsx`, pure `lib/audit-log.ts`, `auditApi`,
  a nav entry. **It deliberately does not poll** — an audit row cannot change,
  so the only thing a poll could surface is a new row, and a trail that reorders
  itself mid-read is worse than one refreshed deliberately. A 403 is a state,
  not an error (Owner/Admin only), rendered as a locked card.
  Also fixed **`#how-it-works`**, dead since 2026-08-13 in three places (nav,
  footer, the hero's "Watch a run"). It is a scroll POSITION, not an element:
  `sceneAnchorTopVh` in `lib/scene-script.ts` converts the run scene's 0.52
  start into an absolute `vh` offset inside the 420vh scrub container, and a
  zero-height div sits there. Pure CSS, derived from `SCENES`. Verified live at
  scrub progress 0.5200.
  And the **root README**, which was still untouched `create-next-app`
  boilerplate, is now the portfolio front page: two Mermaid diagrams
  (architecture + a run's actual sequence, including the interrupt), a demo
  script, and a "deliberately not built" section.
  **432 backend tests** (+2) and **325 frontend tests** (+33).
- **Members + invitations landed 2026-08-18** (Vol. 3 §10 — NOT in the 15-day
  plan; added on request after the audit-log work). Until this, `org_memberships`
  was written by exactly one line in the codebase (`AuthService.register`), so
  every user was the sole Owner of their own org and Editor/Approver/Viewer had
  never been held by a real user. `member:invite`/`member:remove` gated nothing.
  The `organizations` module went models-only → real: `/api/v1/organizations`
  with roster, `members/me`, roles, invite, role change, suspend/reactivate,
  remove, plus a public invitation preview and an accept endpoint. Migration
  `20260818_org_members` makes `user_id` nullable, adds `invited_email`, adds a
  partial unique index for pending invites, and grants the new `member:read` to
  already-seeded Admin/Editor/Approver.
  **Invitations are a signed link, shown in the UI** — there is no email
  delivery, so the accept URL comes back in the response body. `POST
  /auth/register` grew an `invite_token` branch that joins the inviting org
  instead of creating one.
  Access tokens now carry `typ: "access"` and invite tokens `typ: "invite"`,
  checked on both sides — they share a signing key. Full contracts in
  apps/api/CLAUDE.md's members section; the load-bearing ones: the last active
  Owner cannot be demoted/suspended/removed, nobody edits themselves, role and
  status changes MUST invalidate the Redis permission cache, and every
  invitation failure returns one identical 400.
  Frontend: `components/settings/{members-card,invite-member-dialog}.tsx`,
  `app/(auth)/accept-invite/`, pure `lib/members.ts`.
  **467 backend tests** (+35) and **363 frontend tests** (+38).
  Follow-up the same day: **permissions are now shown, not just named.**
  `expand_permissions()` resolves `*` / `*:read` server-side and the API returns
  `effective_permissions`, which let the frontend DELETE its duplicated wildcard
  branch; `GET /organizations/roles` returns all five roles with an `assignable`
  flag, ordered by power. UI: a grant breakdown inside the invite dialog, a
  `Change role…` dialog with a gained/lost diff replacing the bare `Make X`
  items, and a read-only Roles & permissions matrix (Vol. 3 §10).
  Also **replaced the stock-AI glyphs** (the rocket on `workflow.published` is
  `GitCommitVertical`) and added `components/ui/animated-icons/` — hover-only
  nav icons built on the `motion` already in the tree, no new dependency,
  inert under `prefers-reduced-motion`. The motion is unverified under
  automation (the tab is never focused); rest rendering is confirmed.
  Verified live in a browser: invite → link handover → accept page → the
  addressee guard refusing a wrong-account accept → revoke, with the
  `member.invited` row rendering in the audit log.
- **Mobile layout fixed 2026-08-19** after the landing page was reported as
  "nothing aligned" on an iPhone 15 Pro. Root cause was ONE missing utility: the
  platform-tiles grid held a code snippet with a 426px min-content width, and a
  grid item's default `min-width: auto` forced the document to **494px wide on a
  393px viewport** — which shifts and clips every centred section on the page.
  `[&>article]:min-w-0` fixes it; desktop verified unchanged. Also added
  `fovForAspect()` so the 3D camera widens on portrait frames (inert at aspect
  ≥ 1.6 and inert while the photographed room is on screen, both tested).
  **Critical for anyone verifying this: `ResizeObserver` does not fire under
  browser automation**, so R3F's canvas stays 300×150 and the scene renders
  nothing regardless of viewport. A blank canvas there is an artifact, not a
  bug — the scene's *appearance* still has to be checked on a real device.
  Layout is testable via a same-origin iframe (media queries resolve against the
  frame); see apps/web/CLAUDE.md's mobile section for the harness.
  **370 frontend tests** (+7 on the camera).
- **Node-key rename landed 2026-08-20** (frontend only, no backend change) —
  the top product observation from the 2026-08-19 shakedown
  (`Docs/shakedown-fixes.md` §B1). Node keys were auto-assigned `<prefix>_<n>`
  with no rename control, which made a ten-node graph unreadable on the canvas
  and every hand-authored dotted path opaque. New pure `lib/node-rename.ts` +
  an editable key field in the builder's config panel header. The rename is a
  whole-graph rewrite — node identity, both ends of every touching edge (ids
  are derived, so they are rebuilt) and every `node_outputs.<key>` state path in
  any node config or edge condition. Contracts in apps/web/CLAUDE.md's builder
  section. **383 frontend tests** (370 + 13).
- **Shakedown phases 04–08 driven end to end 2026-08-21**, closing section C of
  `Docs/shakedown-fixes.md` — the guardrail 422, cycle, orphan and `unknown_tool`
  canvas rules; the signed webhook plus three forgeries returning one identical
  401 with the quota untouched; a real approval hold → approve → `completed` and
  → reject → `rejected` with the mutating node never executing; manual and cron
  triggers; and the audit trail's Postgres-level immutability plus a 429 at a
  quota of 2. Full results and six new findings in that file's sections G–I.
  **Two changes came out of it:**
  - **`http_request` now follows redirects** (`get_http_client`,
    `follow_redirects=True`, `max_redirects=5`). A 3xx was being classified as a
    definitive answer, so a node calling `api.frankfurter.app` stored a Cloudflare
    301 HTML page as an FX rate and the agent downstream reasoned over it with
    nothing reporting a failure. **469 backend tests** (467 + 2).
  - **The dead `Agents · Soon` sidebar row is now a real page**,
    `app/(dashboard)/agents/page.tsx` — what an agent is in this product today
    (each item linking to a working surface) and what the `agents` module will
    add (each item carrying the engineering reason it is not built). Frontend
    only; **383 frontend tests** unchanged at the time, since the page is
    `lib`-free by the same convention as Settings. (The count moved to 399 with
    the 2026-08-22 Atomie pass — see that bullet.)
  - The headline *product* finding was not a bug and was deliberately not
    "fixed" unilaterally at the time: the approval gate fired on **retrieval
    uncertainty rather than on risk** — a EUR 4,200 purchase was auto-posted
    because retrieval confidently returned coding guidance, while an EUR 85 one
    was escalated because retrieval was vague. `tool_1` searched on a product
    description, so the spend-authority threshold table was effectively
    unreachable. **Closed 2026-08-22 — see the next bullet.** Note this line
    used to say "on the flagship demo graph", which was wrong: the affected graph
    was the hand-built one in the Shakedown runbook, not the seeded demo.
- **Shakedown findings H2/H5/H6 closed 2026-08-22**, plus one latent correctness
  bug found while closing H2. Full detail in `Docs/shakedown-fixes.md` sections
  J and K.
  - **Condition-edge evaluation order was unspecified and could skip an approval
    gate.** `WorkflowVersion.edges` had no `order_by`, `_build_condition_router`
    is first-match-wins, and `evaluate_condition` returns `True` for an edge with
    no predicate — so a catch-all fallback that sorted first made every predicate
    behind it dead code, silently routing around the human gate in front of a
    mutating write. It only ever worked because Postgres tends to return
    insertion order. Fixed: `_ordered_condition_edges` in `src/graphs/compiler.py`
    sorts catch-all edges last then by `(created_at, id)`, and `has_predicate()`
    now lives in `condition_eval.py` and is used *by* `evaluate_condition` so the
    two definitions of "matches everything" cannot drift. The `id` tiebreak is
    load-bearing: `save_draft` re-inserts every edge in one transaction, so
    `created_at` ties across the whole graph.
  - **H2 was a runbook problem, not a seed problem — do not "fix" the demo
    graphs.** `Invoice approval` in `src/db/demo/graphs.py` already routes
    deterministically on `check_amount` and retrieves against `policy_question`.
    The graph that auto-posted EUR 4,200 was the hand-built one the Shakedown
    artifact's phase 03 teaches; that phase is rewritten (money decides first and
    deterministically, retrieval searches on the decision, a second condition node
    carries the model's judgement on the auto branch).
  - Two engine limitations recorded and **not** fixed: parallel edges between one
    node pair are not authorable (`edgeId` is `source->target`), and condition
    nodes cannot chain (the router attaches to the condition's predecessor).
    Nothing validates either on the canvas or at publish.
  - H5: `formatMonthlyCost` shows 4 decimals below a cent — every dev and demo
    month is sub-cent, so the card read `$0.00` permanently. H6:
    `WorkflowResponse.current_version_number` via a viewonly `lazy="joined"`
    `Workflow.current_version` relationship (explicit `foreign_keys` — circular FK
    pair), so the detail dialog says `v2` rather than a UUID.
  - **473 backend tests** (469 + 4) and **387 frontend tests** (383 + 4) —
    the touched suites pass (`test_graph_compiler` 33, `test_workflows` 10,
    `dashboard-stats` 25); the FULL suites were not re-run in that session.
    **That omission shipped a broken schedule tick and a red CI** — see the
    2026-08-22 CI bullet below. Run the full suite before pushing a model change.
    Note `aap_test` was two migrations behind and needed
    `alembic upgrade head` before it would run at all.
- **CI was red and the schedule tick was broken in production; fixed 2026-08-22.**
  Commit `3864a0c` added `Workflow.current_version` as a `lazy="joined"`
  relationship to feed `current_version_number`, and only re-ran the two touched
  suites. The eager LEFT OUTER JOIN that emits is added to **every** Workflow
  query that does not override it — including the schedule tick's
  `SELECT ... FOR UPDATE SKIP LOCKED`, and Postgres rejects `FOR UPDATE` on the
  nullable side of an outer join outright:

  ```
  asyncpg.exceptions.FeatureNotSupportedError:
  FOR UPDATE cannot be applied to the nullable side of an outer join
  ```

  So `dispatch_due_schedules` raised **before dispatching anything** and every
  cron-triggered workflow silently stopped firing. This was not test-only and not
  flaky: 10 tests failed deterministically across `test_trigger_schedule` (all 6),
  `test_run_quota` (both schedule cases) and `test_audit_logs` (both system-actor
  cases).

  Fix: `.options(lazyload(Workflow.current_version))` on that one statement — it
  reads the `current_version_id` **column** and never touches the relationship.
  The eager load stays everywhere else, because that is what response
  serialization needs. The hazard is now documented on the relationship itself in
  `modules/workflows/models.py`; the codebase has exactly one `lazy="joined"` and
  one `with_for_update`, so **any new row-locking query over `Workflow` must add
  the same option** rather than removing the eager load.

  **477 backend tests pass** (473 + 4 that had been failing), verified on a
  throwaway CI-identical stack — a dedicated `pgvector/pgvector:pg16` plus
  `redis:7-alpine`, migrated with `alembic upgrade head` and seeded with
  `seed_roles.py`, exactly as `.github/workflows/ci.yml` does. `ruff check` and
  `ruff format --check` clean.

  **Two traps this hunt exposed, both worth not repeating:**
  - **Never run two pytest sessions against the same database.** Truncate-based
    isolation means the second run's `TRUNCATE` deadlocks against the first run's
    open transactions, and the result is a spectacular *119 failed, 32 errors*
    that looks like a systemic breakage and is pure artifact. It was diagnosed
    only by resolving the deadlock's relation OIDs (`roles` / `workspaces`) and
    then noticing that the individual suites pass in isolation. A background
    `docker exec` pytest can also **survive** the local shell being killed, and
    the image has no `ps`, `pkill` or `pgrep` to check with — walk `/proc/*/cmdline`
    instead.
  - **The full suite takes ~7 minutes here, not the 84s recorded on 2026-08-21.**
    The per-test `TRUNCATE` over a Docker Desktop volume on Windows dominates.
    Budget for it and run it in the background; do not assume it has hung.
- **The internal app was redesigned onto the "Atomie" language 2026-08-22**
  (frontend only, no backend change). Every surface behind the login was
  untouched shadcn — stock neutral tokens, white-card-on-white-page held apart by
  a hairline, the system font stack, no brand colour — which meant the landing
  page sold hard and then dropped the viewer into what looked like a scaffold.
  Reference: `apps/web/public/{Sample,Sample1,Sample2,sample3}.webp`.
  Full spec in apps/web/CLAUDE.md's design-system section. The load-bearing
  points, in the order they will bite someone:
  - **Depth is a FILL STEP, not a border plus a shadow.** A card is one step from
    the page in both themes (light `#F7F7F4` → `#EFEFEC` → `#E7E7E3`; dark
    `#0B0B0B` → `#161616` → `#1E1E1E`). `border` on a `<Card>` is now a bug, a
    Card nested in a Card is invisible (use the new `<CardInset>`), and anything
    genuinely floating goes the other way — `bg-popover` + `shadow-pop`.
  - **`--primary` is lime and it always carries INK, never white**, in both
    themes. Lime sits at L .87; white on it is ~1.4:1, ink is 12.06:1. One lime
    action per screen — that is what `PageHeader`'s single `action` prop enforces.
  - **`--color-status-*` now exists.** Vol. 3 §5 named that set and it never had;
    `badge.tsx`'s cva was standing in with `stat-card.tsx` and `node-catalog.ts`
    hand-mirroring it. All three read one set now, and the ~50 remaining
    hardcoded Tailwind palette classes across the app are gone (zero left outside
    `components/marketing/`).
  - **Type is Plus Jakarta Sans, scoped by `.app-root`.** This retires the old
    "body copy stays on the system SF/Segoe stack" rule for app routes only.
  - **Marketing is untouched and there are three separate guards keeping it that
    way** — `.mk-root` re-declares the full light token set, now also pins
    `--radius: 0.625rem` and every new Atomie token the six shared primitives
    reference, and the font is scoped rather than global. **Any new token an app
    primitive uses must be added to `.mk-root` in the same commit**, or a
    dark-system visitor gets a near-black input on the white landing page.
    Verified live under `<html class="dark">`.
  - New: `components/shared/{page-header,filter-tabs}.tsx`, `components/ui/dot-arc.tsx`
    and the pure `lib/dot-arc.ts`. `PageHeader` removes a real duplication — the
    shell painted `<h1>{title}</h1>` AND every page painted its own `<h2>` two
    rows below it; `FilterTabs` was the same markup pasted into three pages, one
    copy already drifted.
  - Three things were shipped wrong and fixed in the browser, all recorded with
    their reasoning: the bloom was three times too strong, the dot arc bled off
    the card and `overflow-hidden` sliced it into a crescent, and the `-soft`
    chip fills were tuned against white so they measured ~1.03:1 against the card
    and were invisible.
  - Contrast was **measured on the rendered page**, not eyeballed: ink-on-lime
    12.06:1, chips 5.74–8.00:1, foreground-on-card 15.1/16.1:1 across both
    themes. One real failure was caught that way — the eyebrow's lime slash at
    **1.72:1** on the paper — and fixed to 8.59:1.
  - **399 frontend tests** (387 + 12 on `lib/dot-arc.ts`); `tsc --noEmit`,
    `eslint` and `npm run build` clean. Verified in a browser in **both themes**
    across dashboard, workflows, builder, executions list + detail, knowledge,
    audit log and settings, against the live Docker stack with demo data.
  - **Not verified: any real mobile viewport** (same automation ceiling as the 3D
    scene) and the auth pages while genuinely signed out.
- **Real-ERP readiness fixes landed 2026-08-23** — four gaps found scoping a live
  ERP integration, all invisible against the mock connector. Full contracts in
  apps/api/CLAUDE.md's `http_request` section.
  - **URL templating + query parameters.** The URL was entirely static, so
    `GET /invoices/{id}` was unbuildable. `url_fields` fills `{placeholder}`
    segments from state (percent-encoded with `safe=""`, validated both
    directions at write time); `params`/`params_fields` build the query string.
  - **A mutating call is no longer retried when the outcome is unknown.** Every
    `http_request` node used to retry 3× on any timeout or 5xx, so a
    `POST /journal-entries` the ERP committed and failed to acknowledge in time
    was posted three times with nothing reporting it. Replays now require proof
    the request never landed, or an explicit `idempotency` assertion (key is
    `uuid5(run_id:node_key)`, stable across retries and Celery redelivery).
  - **Tool credentials are encrypted at rest** — `tools.secrets_encrypted`,
    AES-256-GCM, migration `20260823_tool_secrets`. They were plaintext JSONB in
    `tools.config` and returned verbatim by every read endpoint. Write-only;
    only `secret_keys` comes back; referenced from config as
    `{{secrets.<name>}}` and substituted in the worker at run start.
  - **`resolve_field_path` indexes into lists.** `{"data": [...]}` was
    unreachable from the condition DSL, agent `input_fields` and tool
    `body_fields` simultaneously.
  - Frontend: the tool dialog gained all four (secrets editor, URL placeholders,
    query params, idempotency switch); `lib/api.ts` gained `secret_keys`/`secrets`.
  - **511 backend tests** (477 + 34), verified with `MINIO_ENDPOINT` on TEST-NET-3.
    **399 frontend tests** unchanged (the touched surfaces are `lib`-free).
    Proven live end to end against the real stack: a registry tool with a
    templated URL, merged query params and an encrypted secret reached a real
    endpoint as `/api/vendors/AC%2FME%201042/invoices?include=lines&period=2026-08`
    with the decrypted `Authorization` header, the unresolved `status` param
    dropped, no headers in the node output, and the list-shaped response readable
    by dotted path.
- **Auth screens redesigned 2026-08-23** (frontend only) — `app/(auth)/layout.tsx`
  is a two-column split with a photographic panel (the app's only remote image;
  `next.config.ts` gained a narrowed `remotePatterns`). Login and register lost
  their card chrome. Contrast measured on the composited panel, and one line
  failed at `white/40` (3.82:1) and was fixed to `/55`. Verified in both themes.
- **Notifications + the `notify` tool type landed 2026-08-23** (Vol. 5 §14–§16's
  missing primitive). `notifications` had never been written to and
  `worker_notifications` had booted with an **empty task registry** since the
  initial commit — so every Vol. 5 HR workflow's terminal Notify step had nothing
  to compile to. `modules/notifications/` went models-only → real,
  `src/workers/notification_tasks.py` is the notifications queue's first task,
  migration `20260823_notify` adds delivery state. **All three worker containers
  now have a non-empty task registry.**
  Shipped as a **tool type, not a NodeType**, on the `knowledge_search`
  precedent. Delivery is **asynchronous** — the node returns `queued`, never
  `delivered` — because Vol. 5 puts Notify after the approval gate and a Slack
  outage must not fail a run whose work is already done and signed off. Channels
  with a transport: `in_app` and `webhook` (Slack/Teams/Zapier). Contracts in
  apps/api/CLAUDE.md.
- **HR: Leave approval demo workflow landed 2026-08-23** (Vol. 5 §14) — the
  fourth demo graph. §14's three HR tools are deliberately **not** invented:
  there is no HR system wired to this platform, so what is built is §14's actual
  subject — two independent exception paths (negative balance, notice/coverage)
  converging on one outcome, grounded in the employee handbook. Balance routes
  **deterministically** (`balance_after < 0`); notice/coverage routes on an agent
  grounded in retrieved handbook text. **It decides and notifies; it does not
  write back to an HR system**, which is pinned by a test rather than left to
  drift — adding `hr.approve_leave` is one mutating `http_request` registry tool,
  at which point the publish guardrail starts requiring the gates it already has.
  Proven live end to end through the real Celery worker, both branches: the
  sample request held at gate 1 (balance −2), approved → retrieval → held at
  gate 2 quoting handbook §4.1 ("five working days or more … at least four weeks
  in advance", 9 days given), approved → notification row written and delivered →
  `completed`, $0.001833. The clean variant ran start → notify with no gate at
  all, $0.001873.
- **Production deployment stack landed 2026-08-26** (Vol. 6 §1, §2, §4) — infra
  only, **no application code changed**. `infra/docker-compose.prod.yml` was
  **0 bytes** and `infra/nginx/` held a lone `.gitkeep`; the same shape as the
  0-byte `apps/api/Dockerfile` that shipped in the initial commit. New:
  `infra/docker-compose.prod.yml`, `infra/nginx/orkest.conf.template`,
  `infra/.env.prod.example`, `infra/DEPLOY.md`.
  **nginx, not Caddy** — Vol. 6 §1–2 already names `nginx:alpine`, the
  network split and certbot. The latency/process argument for nginx over Caddy
  is real only at loads this product will not see; the deciding factors were the
  blueprint and operator familiarity, and the one thing it costs is automatic
  HTTPS, paid once with certbot.
  **Single domain, path-based routing.** Not merely simpler — the only topology
  that needs no backend change: `src/main.py` sets `allow_origins=[]` whenever
  `DEBUG` is false, and the refresh cookie is `SameSite=Strict`. Same-origin
  requests never consult either. A subdomain split would require rewriting both.
  Five gaps found scoping it, each invisible until deployed, all closed:
  - **`/api/` is the WRONG proxy prefix.** `apps/web/app/api/contact/route.ts`
    is a Next.js route handler, so `/api/contact` belongs to `web` and only
    `/api/v1/*` to FastAPI. Proxying all of `/api/` breaks the marketing contact
    form with a 404 that reads as a backend fault. Proven with stub upstreams.
  - **nginx's `client_max_body_size` defaults to 1 MB**, against
    `MAX_UPLOAD_BYTES = 20 MB` in `knowledge_base/service.py`. Every KB PDF over
    1 MB would 413 at the proxy with nginx HTML, and the app's own limit was
    unreachable. Set to 24m so an oversized file is refused by the API's JSON
    error instead. Verified: 5 MB passes, 30 MB is refused.
  - **`FRONTEND_URL` is set by no compose service** and defaults to
    `http://localhost:3000` (`core/config.py`). It is what
    `_frontend_base_url` builds member invitation links from, so in production
    every invite link would have pointed at localhost. It is the ONE variable
    whose omission fails silently, which is why the prod compose marks it
    required rather than defaulted.
  - **`NEXT_PUBLIC_API_URL` is baked at image BUILD time** (`apps/web/Dockerfile`),
    not read at runtime. Built as the relative `/api/v1`. Verified safe:
    `lib/api-client.ts` is its only consumer and is browser-only — no server
    component fetches through it. Changing it needs a rebuild, not a restart.
  - **`.env.prod.example` was silently gitignored** by `.gitignore`'s `.env.*`
    (only `!.env.example` was excepted), so the production template would never
    have travelled with the clone — the exact failure mode the root
    "first run on a new machine" section describes. `.gitignore` now excepts it
    and ignores `infra/certbot/conf|www` (certificate PRIVATE KEYS) and the
    generated `infra/nginx/conf.d/*.conf`.
  Four contracts worth not rediscovering, all documented at their site:
  - **Vol. 6 §1's network snippet cannot work as written.** It puts `api` on an
    `internal: true` network, which disables OUTBOUND routing in Docker — no
    route to OpenAI, to any `http_request` tool endpoint, or to a notify
    webhook. The blueprint's intent (datastores not internet-reachable) is
    implemented instead: `internal: true` carries exactly `postgres`/`redis`/
    `minio`, which need no egress; everything that makes outbound calls is also
    on `public`. What keeps Postgres off the internet is not publishing a port.
  - **Upstreams are resolved through a VARIABLE, not an `upstream {}` block.**
    nginx resolves a static upstream name once at config load and caches it
    forever, so every deploy — which recreates containers with new IPs — would
    serve 502 until reload, up to six hours given the reload loop. The cost is
    that `proxy_pass` no longer appends the URI, so `$request_uri` is explicit
    at each call site; omitting it proxies everything to `/`.
  - **`X-Forwarded-For` is set to `$remote_addr`, not
    `$proxy_add_x_forwarded_for`.** The latter APPENDS to the client's own
    header, which is precisely why `client_ip()` is documented as forgeable.
    nginx is the edge with nothing in front, so overwriting makes the audit
    trail's IP trustworthy. **The rule that it must never GATE anything still
    stands** — putting a CDN in front later silently reintroduces forgeability.
  - **Migrations moved to a one-shot `migrate` service** with
    `service_completed_successfully`, out of `api`'s `command:`. That removes by
    construction the four-containers-racing-`upgrade head` hazard the dev
    compose comment describes, and is the precondition for Vol. 6 §4's replicas.
  Secrets use `${VAR:?message}` with **no defaults anywhere** — the stack
  refuses to boot and names the variable, rather than encrypting BYOK
  credentials under a key committed to this repo. CSP ships
  **report-only** deliberately (the landing page runs WebGL and GSAP inline
  styles; an enforced policy written blind breaks it).
  Verified locally: compose renders with every service but nginx publishing no
  port; the required-secret guards fire with actionable messages; `nginx -t`
  passes on the rendered template; and full routing was proven against stub
  upstreams — `/api/v1/*` and `/health` to the API with paths preserved,
  `/api/contact` and `/_next/*` to web, a forged `X-Forwarded-For` discarded,
  the 5 MB/30 MB body band, port 80 redirecting while `/.well-known/
  acme-challenge/` stays served, and all five security headers present.
  **Not verified: anything on a real VPS.** Nothing has been deployed — no
  certificate has been issued, no real domain resolved, and the demo loop has
  not been run through a public origin. `DEPLOY.md` §6 is the checklist.
- **n8n-style builder, phase 1 of 4 landed 2026-08-28** (frontend only, no
  backend change). The builder worked but did not *teach*: nodes ran top to
  bottom as unlabelled boxes, there was no way to add a step without the palette,
  and nothing anywhere showed what data a node receives or produces.
  Phase 1 rebuilt the canvas: **left-to-right flow** (handles moved to
  `Position.Left`/`Right`), the 7-item palette column **deleted** in favour of a
  searchable, categorised, keyboard-driven node picker, a ⊕ on unconnected
  outputs and on every connection, drag-a-connection-to-empty-canvas, and a
  **Tidy up** auto-layout. New `lib/graph-layout.ts` (hand-written Sugiyama, no
  dagre — the graphs are 5–15 nodes and already validated acyclic),
  `node-picker.tsx`, `edges/builder-edge.tsx`, `builder-actions-context.tsx`.
  Verified in a browser in **both themes** against the live stack: build → autosave
  → publish → edit → new draft, all through the new gestures.
  Six things the browser caught that tests could not, all documented in
  apps/web/CLAUDE.md; the two that would cost the most to rediscover are that
  **the ⊕ can only live on an UNCONNECTED output** (nodes are 220px apart with a
  210px card, so on a connected node the button lands inside the next card, which
  paints over it and steals the hover) and that **Tidy up must frame the bounds it
  computed, not call `fitView`** (React Flow measures from its internal store,
  which still holds pre-layout positions on the next frame).
  Also worth knowing: **`bg-surface-2` is invisible on a popover in dark** —
  `--surface-2`, `--popover` and `--accent` all resolve to `#1E1E1E`. That is a
  pre-existing app-wide issue affecting `components/ui/dropdown-menu.tsx`
  (`focus:bg-surface-2`) and was deliberately NOT changed as part of this work.
- **n8n-style builder, phases 2–4 landed 2026-08-30** — the node detail view,
  drag-and-drop field mapping, and the live run on the canvas. This is the first
  phase with backend work.
  **`config-panel.tsx` is deleted.** Node settings live in a full-screen
  INPUT | PARAMETERS | OUTPUT overlay opened by double-clicking a node. The
  parameter forms are the existing ones, re-hosted unchanged — they encode the
  `_agent_config`/`_tool_config` contract and that is not worth re-deriving while
  moving a panel. New pure modules: `lib/{data-preview,node-output-shape,
  condition-rules,field-drag,state-path,run-overlay}.ts`, all vitest-covered.
  **A condition node has real parameters for the first time** — a routing-rules
  table in evaluation order, replacing "select each edge leaving it". It warns
  when two branches both carry a rule, because the engine guarantees only that
  the fallback runs last: `save_draft` re-inserts every edge in one transaction,
  so `created_at` ties and the tiebreak is a random UUID. The classic
  `> 1000` then `> 100` ladder is therefore unsafe, and nothing else says so.
  **Drag-and-drop writes a dotted state PATH, never an expression** — there is no
  template language here. The picker is the primary implementation and drag is a
  shortcut onto it, because a builder whose central act is mouse-only is not
  finished. Path checking finally knows whether the step named exists and
  **whether it runs before this one**; a forward reference is syntactically
  perfect, resolves to null every run and was reported by nothing.
  Backend (migration `20260830_run_instrumentation`), six behaviours each
  replacing something silently absent — full detail in apps/api/CLAUDE.md:
  `node_executions.input` was an unconditional `None`; `status` was an
  unconditional `"succeeded"` so **no `failed` row had ever been written and
  nothing knew which node broke**; `current_node_key` was only set at an
  interrupt and then as the literal string `"human_approval"`; `latency_ms` was a
  whole-superstep delta shared by every node in the step. Plus
  `POST /workflows/{id}/versions/{version_id}/test-run`, which runs **the version
  on screen including a draft** — the old Test run was pinned to
  `current_version_id`, so on a draft it ran the published graph and reported
  success — and `GET /executions/{id}/status` as the cheap poll.
  Two traps worth not repeating: the failure is **TAGGED, not wrapped**
  (`_NON_RETRYABLE` classifies by exception type, so a wrapper would make every
  config error retryable and re-drive a mutating tool three more times), and
  LangGraph's own exceptions are left alone or every approval gate becomes a
  failed run. `_compile_state_graph` needed `allow_draft` or every test run
  raised `DraftVersionCompileError` — found only by running one.
  Verified live end to end, in a browser: a Test step on the seeded
  `Invoice approval` **draft** ran extract → retrieval → validate on the canvas
  with per-node cost appearing as each finished, held at `approval_1`
  ($0.0028, 38.4s), approved from the run dock, and completed — while
  `post_to_erp` never ran, because the test was told to stop at the gate.
  Asking it to run past the write is refused by name.
  **581 frontend tests** (503 + 78) and **557 backend tests** (535 + 22).
  Both CI legs were verified green on this tree before hand-off: `ruff check`,
  `ruff format --check` and **535 backend tests** pass in 123s against `aap_test`
  (no backend file was touched — 535 is simply the real current figure; the
  511 recorded on 2026-08-23 predates the notifications and HR-leave suites).
  Note the container trap while checking that: `/app/tests` is a COPY, not a bind
  mount, so a stale copy reported five `ruff` E702 errors that no longer exist in
  the repo. `docker cp` the current `tests/` in before believing a backend
  result.
- Next: **actually deploy** (the stack is written and locally verified but has
  never run on a VPS — see `infra/DEPLOY.md`), then **scheduled off-host
  database backups**, which is the largest gap the moment real data exists.
  Then **look at the 3D scene on a real phone** (layout is now verified; the
  scene's appearance is not, and cannot be here) (the one thing it has
  never been seen on — and now more important, since the plate is 1.51 aspect
  and a phone crops it hard — see apps/web/CLAUDE.md), **record the walkthrough**,
  hybrid keyword search
  (the GIN index has shipped unqueried since the initial schema; deliberately cut
  first), OCR, `subgraph` handler, and agent function-calling/ReAct (see the
  deferral note in apps/api/CLAUDE.md).
  Still an empty registry: the `worker_notifications` container (nothing routes to
  its queue yet). `worker_documents` runs `ingest_document` as of 2026-08-15.
- Frontend: initial Next.js/shadcn shell done (auth, dashboard shell,
  workspaces, workflows list), the builder canvas, the Execution Viewer, the
  home dashboard, the tools registry, the knowledge base, the audit log viewer,
  the members/invitations surface, the Agents preview page and the marketing landing page (see above). `app/(marketing)/` now exists and
  owns `/`; `app/page.tsx` is gone.
  `apps/web` DOES have test infrastructure — `vitest.config.mts`,
  `npm test`, **503 tests** over the pure `lib/` modules only (no React harness;
  canvas and page rendering are manual-verification by design).

Verification note: confirm `apps/api/CLAUDE.md` is actually named with
that exact casing (not `claude.md`) — a lowercase filename will silently
fail to auto-load as an always-applied rule file. Run `/context` in a
fresh session to confirm all three CLAUDE.md files (root, apps/api,
apps/web) actually loaded before trusting this status section.