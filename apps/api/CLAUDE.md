# apps/api — Backend Instructions

FastAPI + SQLAlchemy (async) + Alembic + PostgreSQL/pgvector + Redis +
Celery + LangGraph. Modular monolith — see root CLAUDE.md for cross-cutting
rules; this file is backend-specific only.

## Commands

- Install: `poetry install`
- Run migrations: `poetry run alembic upgrade head`
- Seed system RBAC roles: `poetry run python src/db/seed_roles.py`
- Run tests: `poetry run pytest` (run from `apps/api/`)
- Lint: `poetry run ruff check src/`
- Local Postgres/Redis/MinIO: via root `docker-compose.yml`

## Module structure

Each domain module (`src/modules/<name>/`) has exactly: `models.py`,
`schemas.py`, `repository.py`, `service.py`, `router.py`. Existing modules:
`auth`, `organizations`, `workspaces`, `workflows` (includes shell +
versions/nodes/edges), `tools` (real as of 2026-08-08 — CRUD + registry
resolution + `tool_executions`, see the tools section below), `agents` (stub),
`prompts` (stub), `knowledge_base` (stub), `chat` (stub), `notifications`,
`audit_logs`, `analytics` (real as of 2026-08-10 — one read-only endpoint, see
the analytics section below), `billing` (stub), `integrations` (real for one type — BYOK
`openai_api_key`, see security section below; other integration types remain
stub), `webhooks` (stub — OUTBOUND delivery only; the INBOUND webhook trigger
endpoint lives in `executions`, see the triggers section), `settings` (stub).

`audit_logs` became real on 2026-08-09 (both §700 halves — see its own section
below).

`src/graphs/` is separate from `src/modules/workflows/` on purpose — it
holds the LangGraph compiler (`compiler.py`), per-node-type handlers
(`node_handlers.py`), the safe conditional-edge evaluator
(`condition_eval.py`), and the Redis-backed compiled-graph cache
(`cache.py`). Graph *execution artifacts* are distinct from workflow
*metadata*.

`src/workers/` holds Celery app config (`celery_app.py`), the LangGraph
execution tasks (`graph_tasks.py`), the scheduled-trigger beat tick
(`trigger_tasks.py`), and the PostgreSQL checkpoint saver
(`postgres_saver.py`). The `executions` module (`src/modules/executions/`)
owns `WorkflowRun` and `NodeExecution` models, schemas, repository, service,
and router — plus the inbound webhook ingress endpoint (see the triggers
section below for why it lives there and not in `webhooks/`).

## Testing conventions

- Tests live in flat `apps/api/tests/test_<domain>.py` files, not nested
  under `src/`.
- Reuse fixtures from `apps/api/tests/conftest.py` (test DB session, test
  client, auth helpers) — don't redefine them per file.
- **Isolation is truncate-based, and it must stay that way** (added
  2026-08-08). `_clean_database` TRUNCATEs every `public` table except
  `alembic_version` around each test, and `_stub_celery_dispatch` replaces
  `.delay` on both graph tasks with a recorder (depend on `celery_calls` to
  assert on dispatches). Before this, a routine `pytest` run against the
  Docker dev stack left ~130 fixture orgs in `aap_db` and handed the live
  worker a queue of real `execute_workflow` jobs.
  The usual wrap-each-test-in-a-rolled-back-transaction pattern was tried
  first and **does not work here** — don't re-attempt it. It needs every
  session on one Connection, and (a) LangGraph's `AsyncBackgroundExecutor`
  issues concurrent `aput`/`aput_writes`, which one asyncpg connection
  answers with `InterfaceError: another operation is in progress`, killing
  every `_stream_graph` test; (b) `created_at` is `server_default=func.now()`
  and Postgres' `now()` is transaction start time, so every row in a test
  gets an identical timestamp and the cursor-pagination tests fail.
  `testcontainers` (Vol. 7 §4) is still not wired up.
- **The suite REFUSES to run outside a `*_test` database** (guard added
  2026-08-15, `_assert_safe_test_database` at the top of `conftest.py`, above
  every fixture). Truncation is correct isolation and a catastrophic default:
  it wipes whatever `DATABASE_URL` names. On 2026-08-15 a run inside the
  `aap_api` container — where `DATABASE_URL` is the **dev** database — destroyed
  an org, a user, a published workflow and its entire run history. Nothing
  warned, and the only symptom was the next login failing with "system roles not
  seeded", because `roles` had been truncated too.
  It is a hard `pytest.exit` at import time, not a fixture: by the time fixtures
  run the first TRUNCATE is already imminent. `AAP_ALLOW_DESTRUCTIVE_TESTS=1`
  overrides it for a throwaway stack or a CI database whose name doesn't match.
  Running the suite therefore means naming the test DB explicitly:

  ```
  docker exec aap_postgres psql -h 127.0.0.1 -U aap_user -d postgres -c "CREATE DATABASE aap_test;"
  DATABASE_URL=postgresql+asyncpg://aap_user:aap_pass@postgres:5432/aap_test python -m alembic upgrade head
  DATABASE_URL=postgresql+asyncpg://aap_user:aap_pass@postgres:5432/aap_test python -m pytest
  ```

  `aap_test` needs migrating like any other database, and again after every new
  migration — a fresh one is empty, and the guard only checks the *name*.
- Every new tenant-scoped endpoint needs an explicit cross-tenant isolation
  test: create two orgs, confirm Org A's token gets a 404 (never a 403,
  never a data leak) on Org B's resources.
- Structural/business-rule validation gets unit tests with a mocked DB;
  end-to-end behavior (including auth, RLS, real Postgres) gets
  integration tests against the real test DB.

## Security non-negotiables

- Password hashing: argon2 only.
- Access tokens: short-lived JWT (15 min), never in localStorage. Refresh
  tokens: httpOnly, Secure, SameSite=Strict cookie, rotated on every use.
- Never log or return raw secrets/API keys in any response.
- BYOK OpenAI keys (`integrations` module, Vol. 2 §13): encrypted at rest with
  AES-256-GCM (`src/core/encryption.py`), key from `INTEGRATION_ENCRYPTION_KEY`
  (separate secret from `SECRET_KEY`/`JWT_SECRET_KEY`, required, no default).
  `IntegrationStatusResponse` only ever exposes `last_four` — there is no
  code path that decrypts and returns the raw key over HTTP, even to the
  owning org. `INTEGRATION_READ`/`INTEGRATION_WRITE` are Owner-only (not
  granted to Admin in `seed_roles.py`), same reasoning as `BILLING_READ`/
  `BILLING_WRITE`: a stored key is a direct billing-exposure lever. Wired
  into execution via `LLMClient.api_key_override` — see the docstring on
  that parameter and `_resolve_llm_client_factory` in
  `src/workers/graph_tasks.py`. No live validation call to OpenAI at
  set-time (would put a third-party network dependency on a write
  endpoint) — only structural checks (`sk-` prefix).
- Graph validation is **split by intent** — don't collapse these back together:
  `save_draft` calls `validate_draft_structure()` (duplicate `node_key`, edges
  referencing a missing `node_key` — the two rules that would corrupt storage),
  while `publish_version` calls the full `validate_graph_structure()` (adds
  start/end presence, orphans, cycles) plus `validate_mutating_approval()`. A
  draft is *allowed* to be an unfinished graph: the Builder canvas autosaves
  after every node drop, and every intermediate state violates at least one
  shape rule. The compiler is unaffected — it only compiles versions with
  `published_at` set. `test_validate_draft_structure_allows_partial_graphs`
  pins both halves (each parametrized case must save AND must fail strict
  validation, so the list can't rot into already-valid graphs).
- Any node with `is_mutating: true` in its `config` (ERP writes, payments) must
  sit downstream of a `human_approval` node (Vol. 4 §4.3). **ENFORCED** by
  `validate_mutating_approval()` in `src/modules/workflows/service.py`, which
  raises `GraphValidationError` → 422 naming the offending `node_key`s. Proven
  by `tests/test_workflow_versions.py::test_unapproved_mutating_graph_saves_as_draft_but_fails_to_publish`
  (verified to fail when the call is removed, so the gate is load-bearing).
  Know the three limits before relying on it as a safety net:
  - **Publish-time only, not save_draft** — deliberate, so an author can park a
    half-built graph while wiring the approval gate.
  - **∃-semantics, not ∀** — a mutating node passes if *any* `human_approval`
    exists in its ancestor set, even when some individual branch reaches it
    unapproved. Vol. 4 §4.3's wording is "has **no** upstream approval node in
    its dependency path", and ∀ would reject the blueprint's own Vol. 5 §1 and
    §5 workflows, which both route straight to the journal-entry write on their
    clean branch. See `test_mutating_node_with_one_approved_branch_passes_exists_semantics`.
  - **Fail-open on a typo — for INLINE-CONFIG NODES ONLY.** This was narrowed,
    not closed, when the tools module landed on 2026-08-08; do not restate it
    either as still-universal or as fixed. A node that references a registry
    `tool_id` now fails *closed*: `tools.is_mutating` is a typed bool column
    that cannot be misspelled, `publish_version` resolves it, and a node may
    **upgrade** but never **downgrade** a registry tool's flag. A node carrying
    inline config still reads free-form JSONB and a misspelled `is_mutation`
    still silently skips the gate — `_tool_config` catches `"true"` at invoke
    time, but nothing catches a wrong key name.
  - **Publish also now rejects a `tool_id` that resolves to nothing** —
    nonexistent, another org's, or soft-deleted — with a 422 naming the
    node_key (`WorkflowService._resolve_registry_tools`). Nodes carrying inline
    `tool_type` are exempt: inline config is the supported non-registry path
    and a stray forward-compat `tool_id` beside it stays a documented no-op.

## Celery worker — two invariants that were silently broken until 2026-08-07

The worker had never successfully executed a task from the broker. Both of these
are load-bearing; breaking either produces a run that sits at `pending` forever
while the UI looks like the bug.

- **`celery_app` must declare `include=["src.workers.graph_tasks"]`.** `celery -A
  src.workers.celery_app worker` imports only that module. Without `include` the
  task registry is empty, the worker boots clean, and every job is discarded with
  "Received unregistered task of type ...".
- **Non-FastAPI entry points must import `src.db.all_models`.** SQLAlchemy
  resolves `relationship("Workspace")` string targets at first mapper
  configuration. The worker imports executions/workflows models but not
  workspaces/auth/audit_logs/tools, which are relationship targets from them, so
  the first query dies with "expression 'Workspace' failed to locate a name".
  The FastAPI app never hits this because its routers transitively import
  everything. `alembic/env.py` keeps its own copy of that import list.
- **Celery tasks must run through `_run_async`, not bare `asyncio.run`.**
  `db.database.engine` is a module-level pool and each task runs its own
  `asyncio.run()`, i.e. a fresh event loop. asyncpg connections are bound to the
  loop that opened them, so a connection pooled by task N is checked out by task
  N+1 against a dead loop and the first write raises `AttributeError: 'NoneType'
  object has no attribute 'send'`. `_run_async` disposes the engine inside the
  same loop. `pool_pre_ping` does not help — the ping runs on the dead transport.
  The test suite cannot catch this: it awaits `_stream_graph()` directly and
  never goes through the Celery task functions.

### `_stream_graph` runs once per LEG, not once per run (fixed 2026-08-15)

This is the mental model to hold before touching anything in that function. A
`human_approval` interrupt means the task exits and a *second* task later resumes
the same run — so every statement in `_stream_graph` executes at least twice for
any workflow with a gate, and N+1 times for N gates.

`started_at` was written as a bare `datetime.now(UTC)` on that path, so the
resume overwrote the original. `completed_at - started_at` — which the Execution
Viewer renders as the run's duration — measured only the leg *after* someone
clicked Approve. Found on the first real HITL run: the gate held 18.3s and the
row reported 0.04s.

- **`_started_at_first_leg_only()` is the fix**, a SQL
  `COALESCE(started_at, now())` so the first write wins and later legs are
  no-ops. Not a read-then-write: two legs of one run cannot overlap, but the
  racy shape would cost the same and buy nothing.
- **`created_at` was always the honest trigger time** and still is. Nothing was
  ever lost; it just was not the column anything read. If you need "queued at"
  versus "execution began", those are `created_at` and `started_at` respectively
  — and now they mean that.
- **Pinned by `test_started_at_survives_a_resume`**, which drives `_update_run`
  across three simulated legs. Verified to fail against the old bare-`now()`
  version, so the guard is load-bearing rather than decorative.
- The same trap applies to anything else you might reach for here: **do not add
  a "set once at start" side effect to `_stream_graph` without making it
  idempotent across legs.** Counters, timestamps and audit rows all have this
  shape.

## Known temporary gaps (don't silently "fix" these — they're deliberate)

- `prompt_id` references inside node `config` are stored as opaque UUIDs with
  no FK validation, since that module isn't built. Compiler logs a warning,
  doesn't block. `agent_id` is the same, except on a node already carrying
  inline `output_schema`, where the id is a forward-compat no-op rather than an
  unresolved reference. **`tool_id` is no longer in this bucket** — see the
  tools section below.
- `subgraph` node handler is still a stub that raises
  `NodeNotImplementedError` if actually invoked. `tool` is real as of
  2026-08-04.
- `tool` nodes support **two** config paths, and inline always wins:
  - **Inline** (`tool_type`, plus `url`/`method`/`headers`/`body`/`body_fields`/
    `timeout_seconds` for `http_request`, or `action`/`payload`/`payload_fields`
    for `erp_connector`). Still fully supported, forever — the Builder's
    `node-catalog.ts` emits these shapes and must not have to change.
  - **Registry** (`tool_id` only, no `tool_type`), resolved at run start. See
    the tools section below.

  Values reach the request via `body_fields`/`payload_fields`,
  `{destination_key: "dotted.state.path"}` maps resolved by the same
  `resolve_field_path` the condition DSL uses — the URL itself is static, with
  no interpolation yet.
- `erp_connector` is a **mock**: it makes no network call and returns
  `{"posted": true, "confirmation_id": "MOCK-<uuid>", ...}`. It exists so the
  mutating-tool mechanism can be proven before a real ERP adapter exists.
  It accepts both `create_journal_entry` (Vol. 2 §7.2's ERPConnector interface
  name, canonical) and `post_journal_entry` (Vol. 5 §5's diagram label), because
  the blueprint uses both spellings and both workflows must be buildable verbatim.
- Vol. 2 §7.2's other two tool types, `python_function` and `mcp`, are rejected
  by name — not silently accepted.
- `tool_executions` **is written now**, before the call — see the tools section
  below. What remains a gap: only *registry-backed* nodes log, because
  `tool_executions.tool_id` is NOT NULL and an inline-config node has no row to
  point at. That is inherent, and the concrete incentive to move nodes onto
  registry tools — which authors can now actually do from the UI: the Builder's
  tool config form grew a registry picker on 2026-08-12, alongside a
  `/tools` management page. Both are frontend-only; nothing here changed.
- `agent` nodes carry their model/prompt/schema **inline** in node `config`
  (`system_prompt`, `output_schema`, `input_fields`, `model`, `temperature`,
  `max_tokens`) rather than resolving `agent_id` against `agents`/
  `agent_versions`. This is a deliberate temporary denormalization — the
  agents module is models-only, so there is nothing to look up. `agent_id` is
  accepted and ignored. When the agents module lands it should resolve
  `agent_id` into this same shape so neither `agent_handler` nor the Builder
  UI's node config panel has to change. A node carrying *only* `agent_id`
  raises `AgentNodeConfigError` at invoke time.

## Tools module (landed 2026-08-08)

`/api/v1/tools` — POST / GET list / GET / PATCH / DELETE, `tool:write` and
`tool:read` (both already existed in `permissions.py` and were already granted
to Admin and Editor, so no seed migration was needed). Migration:
`alembic/versions/20260808_tools_module.py`.

**`tools` has a direct `organization_id`** (it inherits `TenantMixin`; the
initial schema emits the column, its index and the FK, and it is in the RLS
policy set). Scope on it directly — do NOT "fix" this into a join through
`workspaces`. The workspaces join is only for verifying a client-supplied
`workspace_id` on create.

Four things to know before touching it:

- **A row is validated by the code that executes it.** `ToolService` calls
  `validate_tool_config`, the public alias for `_tool_config` in
  `node_handlers.py`. A row that saves is a row that runs, there is no second
  adapter schema (Vol. 2 §7.2), and `python_function`/`mcp` are rejected at
  **create** with a 422 rather than stored as rows that only explode later.
- **Resolution happens once per run, before compile** — `_resolve_tool_configs`
  in `graph_tasks.py`, threaded through `_compile_state_graph` /
  `_bind_node_handler` as `tool_configs`. This is the BYOK `client_factory`
  precedent verbatim, and it is not negotiable: `tool_handler` is *synchronous*
  inside a LangGraph superstep with no session and nothing to await, and
  per-invocation resolution would also break `compile_for_test_run`, which has
  no DB at all. Never thread `tool_configs` into the Redis-cached
  `compile_graph()` path — it would serve a stale Tool row after an edit.
- **The merge is asymmetric on purpose.** A node may override only
  `body`/`body_fields`/`payload`/`payload_fields` (per-usage state wiring).
  `url`/`method`/`headers`/`action`/`timeout_seconds`/`is_mutating` come from
  the registry and are **not** node-overridable — otherwise a node could
  re-point a reviewed tool at an arbitrary endpoint while the publish gate went
  on reading `is_mutating=false` off the registry row it no longer describes.
  `ToolService.NODE_OVERRIDABLE_KEYS` is the list.
- **Delete is soft, and 409s while a published version references the tool.**
  `tool_executions.tool_id` is `ON DELETE CASCADE`, so a hard delete would
  erase the audit trail Vol. 4 §4.3 exists to create. Draft references do not
  block — the author is still editing.

### `tool_executions` — the write-before-execute audit trail

Vol. 4 §4.3 wants the row written *before* the call, "so a crash mid-call still
leaves an audit trail of intent". `ToolExecutionLogger` (in
`modules/tools/service.py`) does that with `begin()` / `finish()` in **two
separately committed transactions** — that separation IS the feature; one
transaction spanning the call would roll the intent row back on a crash, the
exact outcome §4.3 rules out.

- It writes through a **second, synchronous engine** (`src/db/sync_database.py`,
  psycopg2, already a dependency; NullPool). That exists solely because
  `tool_handler` is sync with no awaitable context. It is disposed in
  `_run_async`'s finally block alongside the async engine, and in the test
  suite's teardown — keep both.
- Ordering end to end: INSERT(intent, `status="running"`) → outbound call →
  UPDATE(outcome) → `node_executions` row → FK back-fill.
  `node_execution_id` starts NULL because the `node_executions` row does not
  exist yet — `_stream_graph` only inserts it after the superstep yields. The
  ids ride back on the `node_tool_calls` state channel (a sibling of
  `node_usage`, stripped by `_output_snapshot` for the same reason), and
  `_link_tool_executions` back-fills them.
- `_insert_node_execution` returns `uuid.UUID | None` (was `bool`) — None means
  the idempotency skip fired, so there is nothing to back-fill and the FK
  legitimately stays NULL.
- **One row per node invocation, not per HTTP attempt.** `_run_http_request`
  retries 3× internally; `latency_ms` is the total.
- **`tool_executions.input`/`output` are a new leak surface.** `tools.config`
  legitimately holds an Authorization header. `_audit_input` drops headers
  outright and `_safe_url`-strips the query string, same rule as node output.
  Pinned by `test_audit_input_carries_no_headers_and_no_query_string`.

### Contracts invented here (the blueprint documents none of them)

Vol. 2 §9.2 lists no tools endpoints at all, so most of this surface is derived
from §9.1's conventions rather than transcribed. Flagged so a later reader
knows what to weigh against the docs: the endpoint set itself; `is_mutating` as
a typed column (§4.3 says "in their config"); `tools.description` (absent from
§3.3, required by §4.2 and by OpenAI's function spec); `is_active` +
soft-delete + the 409-if-published rule; `UNIQUE (workspace_id, name)` and the
`^[a-zA-Z0-9_-]{1,64}$` name grammar; rejecting `python_function`/`mcp` at
create; the merge precedence and non-overridable key set; no-downgrade of a
registry mutating flag; `status="running"` for the intent row; one row per
invocation; and shallow-only `input_schema` validation (no `jsonschema` dep).

### Deferred: agent function-calling / ReAct

`ToolService.function_specs()` builds the OpenAI `tools=` array and is
unit-tested, but nothing calls it yet. The loop itself is deferred, for reasons
worth not rediscovering: `LLMClient` has one entry point, `parse()`, which is
structured-output-only — a loop needs a second method plus N-call cost
accumulation (`LLMResult` is per-call and `_usage_for_node` expects exactly one
usage dict per node); `max_iterations` lives on `agent_versions`, a table the
models-only agents module owns; and **the guardrail hole is a design question,
not an implementation detail** — tool calls emitted by an agent have no node in
the graph, so `validate_mutating_approval` structurally cannot see them, and
that needs a *runtime* refusal rather than an extension of the publish-time walk.

## Workflow triggers (landed 2026-08-09)

`trigger_type` was decorative until this release — the column shipped in the
initial schema, the Builder offered all five values, and no code read it. Now
three of the five work; `email` and `event` are **rejected at write time** with
a 422 (`IMPLEMENTED_TRIGGER_TYPES` in `modules/workflows/service.py`) rather
than stored as a workflow that can never fire.

New columns on `workflows` (migration `20260809_workflow_triggers`):
`next_run_at`, `last_triggered_at`, `webhook_secret_encrypted`.

Six contracts to know before touching any of it:

- **The database is the schedule, not beat.** One beat entry
  (`dispatch-due-schedules`, 60s) enqueues a tick that polls for due workflows.
  Do NOT "improve" this into one beat entry per workflow: beat's schedule is
  process-local, so that needs a live reconfiguration channel into a running
  container and loses every entry on restart. The poll has neither problem.
- **The tick runs on `worker_workflow`, not on beat.** Beat only publishes; the
  `beat` container has no `DATABASE_URL` and must not need one. The task is
  routed to `workflow_execution` because that is the only queue with a live
  consumer — `worker_documents`/`worker_notifications` still boot with empty
  registries.
- **Three guard conditions are cost-safety, not tidiness.** Each scheduled run
  can spend LLM money unattended. (a) Only `status='published'` AND
  `current_version_id IS NOT NULL` are picked up — a draft carrying a cron
  never fires. (b) `next_run_at` advances in the SAME transaction as the run
  insert, and the select is `FOR UPDATE SKIP LOCKED`, so overlapping ticks can't
  double-fire. (c) **Catch-up is suppressed** (`_advance_from`) — a workflow six
  hours overdue fires once and re-arms from *now*, never replaying the backlog.
- **Crons are evaluated in the config's IANA timezone, then converted to UTC.**
  `0 9 * * 1-5` means 9am local; evaluating it in UTC would shift every run by
  the offset and drift an hour twice a year in DST zones. Sub-minute crons are
  rejected by measuring the actual gap between the next two fire times —
  `croniter.is_valid()` alone accepts a 6-field seconds expression.
- **The webhook secret is ENCRYPTED, not hashed** — `models.py` used to document
  `{"secret": "<hashed_secret>"}` and that was never implementable. HMAC is
  symmetric: verification needs the same plaintext the caller signed with. It
  reuses `core/encryption.py` and lives in its own column rather than in
  `trigger_config`, because `trigger_config` is echoed verbatim by
  `WorkflowResponse`. Returned exactly once, at generation;
  `has_webhook_secret` is a bare bool because no prefix of an HMAC key is safe
  to publish. Gated on `workflow:publish`, not `workflow:write` — the secret
  lets a bearer start production runs with no login.
- **`POST /api/v1/triggers/workflows/{id}` is the only unauthenticated route,
  and its uniform 401 is load-bearing.** Unknown workflow, wrong trigger type,
  no secret, forged signature and stale timestamp must stay byte-identical in
  the response, or the endpoint becomes an oracle for enumerating workflow
  UUIDs across every tenant with no credentials. `verify_webhook_signature`
  therefore returns a bare bool and runs a dummy HMAC on the missing-secret
  path so the miss costs the same wall-clock time. It signs
  `"{timestamp}.{raw_body}"` — the timestamp is inside the signed material, or
  the 5-minute freshness window would be advisory and any captured request
  would replay forever — over `await request.body()`, never re-serialized JSON.

`WorkflowRepository.get_by_id_unscoped` / `mark_triggered` are the one
deliberate exception to tenant scoping, for that endpoint alone. The invariant
still holds: `organization_id` is read off the workflow row, never from the
request. Don't reach for them anywhere else.

The ingress endpoint lives in `modules/executions/` rather than `modules/
webhooks/` because its job is to create a `WorkflowRun` and it reuses that
module's repository and enqueue path. The `webhooks` model is for OUTBOUND
delivery registrations — a different concern, still a stub.

## Audit trail (landed 2026-08-09)

Vol. 2 §13 §700 asks for two independent controls. Until this release **neither
existed**, and `models.py` asserted that one of them did ("a Postgres trigger
created in the initial migration") — there was no `CREATE TRIGGER` anywhere and
nothing had ever written a row.

`/api/v1/audit-logs` — **GET only, forever.** §700: "no UPDATE/DELETE route
exists". `test_no_mutating_route_on_audit_logs` asserts 405 on POST/PATCH/PUT/
DELETE, so adding one fails the suite. Gated on `audit:read` (Owner/Admin).

Five things to know:

- **Writes are inline and transactional, NOT via the event bus.** `AuditService.
  record()` adds the row to the caller's session so the action and its audit row
  commit or roll back together. Subscribing to `core/events.py` looks tempting
  and is wrong: `EventBus.publish` dispatches with a bare
  `asyncio.create_task(...)` it never awaits or stores, so a failing handler
  loses its exception, the request's session can close first, and nothing orders
  the write against the action's commit. Best-effort audit is not audit.
  `test_audit_write_rolls_back_with_its_action` pins the atomicity.
- **The DB trigger blocks hard-deleting an organization.** `audit_logs.
  organization_id` is `ON DELETE CASCADE` and a cascade is a DELETE, so it hits
  `reject_audit_log_mutation()`. No code path hard-deletes an org, and "an
  org's trail can't be erased by deleting the org" is the property §700 wants —
  this is correct, not a bug. A GDPR-erasure path must be a reviewed migration
  that drops, purges and recreates the trigger. **Verified live**: `DELETE FROM
  organizations` now errors.
- **TRUNCATE is deliberately still allowed.** Postgres fires TRUNCATE triggers,
  not row-level UPDATE/DELETE ones, on a TRUNCATE — which is the only reason
  `conftest.py::_clean_database` still works. Do not "harden" this with a
  TRUNCATE trigger; every test in the repo would fail at teardown, and §700
  names UPDATE and DELETE only. Pinned by `test_truncate_still_works`.
- **Actor context is an explicit parameter, never a contextvar.**
  `AuditContext` comes from `Depends(get_audit_context)` in a router, or
  `AuditContext.system()` in a worker. Half the call sites are Celery tasks with
  no request, where a contextvar would silently attribute a scheduled run to
  whichever user last made an HTTP call in that process.
- **`ip_address` is caller-controlled and must never gate anything.**
  `client_ip()` prefers the leftmost `X-Forwarded-For` hop, which any client can
  forge — there is no trusted-proxy validation. It is a forensic hint only.

`metadata` must never carry a secret. The credential actions record
`integration_type` + `last_four`; the webhook rotation records only
`replaced_existing`. Two tests grep the whole response for the real value.

**Two ORM identity-map traps were found writing this** — both produced a
*stale* read, and both will recur if you reach for the same shape:
`.returning(Model)` resolves to an instance already in the session's identity
map rather than refreshing it from the RETURNING row. So `get_by_type()` before
`upsert()` makes the upsert hand back the OLD `last_four`
(`IntegrationRepository.exists_by_type` exists solely to avoid this — it selects
a scalar column, which does not populate the identity map), and reading
`workflow.webhook_secret_encrypted` *after* `repository.update()` yields the new
value. Capture before-state before the write.

## Analytics module (landed 2026-08-10)

`GET /api/v1/analytics/dashboard` — the four Vol. 3 §5.1 stat cards (Active
Runs, Needs Approval, Cost MTD, Success Rate). Read-only, one verb, no
migration. `test_no_mutating_route_on_the_dashboard` asserts 405 on
POST/PATCH/PUT/DELETE, same guard as audit_logs.

- **It has no `models.py`, deliberately.** This is the one module that breaks
  the "exactly five files" convention above: analytics owns no tables and
  defines no entities, it aggregates `workflow_runs`. An empty `models.py`
  would imply a schema that does not exist and would need adding to
  `src/db/all_models.py` for nothing.
- **Gated on `execution:read`, NOT a new `analytics:read`.** Every figure is a
  roll-up of data that permission already exposes per-run (`total_cost_usd` is
  on `WorkflowRunResponse`), so a separate grant would add a seeding concern
  while protecting nothing, and would lock Viewer out of the product's home page.
- **One query, five FILTER aggregates.** `workflow_runs` is the highest-volume
  table and this endpoint runs on every dashboard load; don't split it back into
  five round-trips.
- **The success-rate denominator excludes `rejected` and `cancelled`, and that
  is a product decision.** A rejected run is the Vol. 4 §4.3 approval gate
  working correctly — counting it as a failure means an org's success rate falls
  the more carefully it reviews mutating actions, inverting the incentive the
  gate exists to create. Widening the denominator is not a bug fix.
  `test_rejected_and_cancelled_runs_are_excluded_from_the_success_rate` pins it.
- **`success_rate` is `None`, never `0.0`, when nothing has finished.** Zero
  finished runs means the rate is undefined; `0.0` renders as "0%" and tells a
  new org its automation is broken. The frontend renders null as an em dash.
- **The two in-flight cards are all-time; cost and success rate are windowed**
  (current UTC month, trailing 30 days). A run blocked on an approval for months
  is exactly what the card exists to surface, so it must not age out.
- The month boundary is **UTC**, because there is no per-org timezone column to
  use. Revisit when billing becomes real — an invoice period and this figure
  should agree.
- Recent Executions and Your Workflows are NOT served from here; the frontend
  calls the existing executions/workflows list endpoints so it shares a React
  Query cache with those pages.

## Per-org daily run quota (landed 2026-08-09)

Vol. 2 §667: "Per organization, workflow triggers | Plan-dependent (e.g. 1,000
runs/day on Pro) | Redis counter, resets daily; enforced before Celery enqueue."
`core/cache.py`'s `rate_limit_*` primitives had been written and entirely unused
since the initial commit; `consume_run_quota()` at the bottom of that module is
the first caller.

- **Enforced on all three trigger paths.** Manual and webhook raise 429 with
  `Retry-After` (via `ExecutionService._claim_run_quota`); the schedule tick
  can't raise HTTP, so it skips the workflow, logs, and writes a
  `workflow.run.quota_exceeded` audit row — a silently skipped cron run would be
  indistinguishable from a bug.
- **Claimed before `create_run`**, so an over-quota request leaves no `pending`
  run. One that nothing will ever execute looks exactly like the three worker
  bugs fixed on 2026-08-07 and would be misdiagnosed as one.
- **NOT claimed on resume.** Approving a waiting run continues a run counted at
  trigger time; charging twice would make every Vol. 5 reference workflow
  (they all have approval gates) cost double its quota.
- **On the webhook path, claimed only AFTER the signature verifies.** Claiming
  first would let anyone who knows a workflow UUID exhaust a tenant's entire
  daily allowance with forged requests — a credential-free remote DoS.
  `test_forged_webhook_requests_cannot_burn_the_quota` pins the ordering.
- **Fixed UTC-day window, not rolling** (§667 says "resets daily"): the date is
  part of the Redis key and the TTL runs to the next midnight, so the whole
  allowance returns at once. No reset job to forget.
- **INCR-then-compare**, matching the existing `RateLimiter`. Check-then-INCR
  races and lets concurrent triggers overshoot. The tradeoff is that rejected
  attempts also increment, so `used` can exceed `limit` — that is visible in the
  counter and harmless, since the TTL clears it either way.
- `DAILY_RUN_QUOTA_PER_ORG` (default 1000, §667's own Pro example; `0` disables)
  is the placeholder for the plan lookup §667 actually wants — the billing
  module is models-only, so there is no plan to read. `consume_run_quota` is the
  single call site to change when plans become real. It is set on all five app
  services in `infra/docker-compose.yml`.
- `tests/conftest.py::_clear_run_quota_keys` drops `rate_limit:org_runs:*` around
  each test. Scoped, **not `flushdb`** — the same Redis holds the JWT blocklist
  and permission cache, and a blanket flush during a test run would log out a
  developer's live session.

## `*:read` no longer grants every read permission

Fixed 2026-08-09 while adding `audit:read`. The Viewer system role holds
`"*:read"`, and `permission_granted`'s wildcard branch satisfied **every**
`:read` from it — including `integration:read` and `billing:read`, which this
codebase documents in two places as Owner-only. A Viewer could read the org's
BYOK integration status. `WILDCARD_READ_EXEMPT` in `core/permissions.py` now
excludes those two plus `audit:read` (the most sensitive of the three — actor
identity and client IPs). Owner's `"*"` is unaffected. If you add a sensitive
read permission, add it to that set; `test_read_wildcard_does_not_grant_sensitive_read_permissions`
is the regression guard.

## Embeddings (landed 2026-08-12, ahead of the RAG pipeline)

`LLMClient.embed()` plus `_EMBEDDING_MODELS` in `src/core/llm_client.py`. **No
migration, no new module, and nothing calls it yet** — `knowledge_base` is still
models-only. This exists so that the ingestion pipeline, when it is written, has
exactly one place to get a vector from and cannot choose its own dimension count.

It was prompted by a real discrepancy in the schema: `knowledge_bases.
embedding_model` defaults to `text-embedding-3-large`, whose native output is
**3072** dimensions, while `document_chunks.embedding` is `Vector(1536)` and
`agent_memory.embedding` likewise. Two docstrings asserted 1536 *was* -large's
native width. It is not. All three comments are now corrected.

Six things to know:

- **The mismatch is resolved by requesting 1536, not by switching to
  `-small`.** The 3-series is Matryoshka-trained, so -large's leading 1536
  dimensions are a well-formed embedding that still retrieves better than -small
  at the same width. The platform gets -large's quality at -small's storage,
  HNSW index size and query latency, with no migration. The only thing it costs
  is the API rate (~$0.13/M vs ~$0.02/M) — a rounding error at any corpus size
  this product will see before billing is real.
- **`dimensions` is never a call-site argument.** It is resolved from
  `_EMBEDDING_MODELS` inside `embed()`. One forgetful caller passing nothing
  would get 3072 back, and the failure mode is not always loud — if a wrong-width
  vector ever *does* fit the column, it lands in the same HNSW index as
  everything else and every later cosine search is quietly wrong.
- **`embedding_spec_for()` fails CLOSED — the opposite of `_pricing_for()`, on
  purpose.** An unknown chat model warns and bills at the most expensive known
  rate, because a wrong price is reconcilable later. An unknown *embedding* model
  raises, because there is no safe default dimension to guess and a wrong guess
  corrupts an index rather than a report. Don't "make it consistent" with the
  pricing helper.
- **`EMBEDDING_COLUMN_DIMENSIONS = 1536` is checked at import.** Adding a model
  to `_EMBEDDING_MODELS` that requests a different width raises
  `LLMConfigurationError` before the app boots. That is deliberate: it catches
  the mistake at deploy rather than at the first ingestion run in production.
  Changing the constant means an Alembic migration that alters BOTH vector
  columns and **re-embeds every existing row** — stored vectors cannot be
  converted, only regenerated.
- **`model` is a required argument on `embed()`, with no settings fallback**,
  unlike `parse()`'s `OPENAI_DEFAULT_MODEL`. The authority is the owning
  `knowledge_bases.embedding_model` row. A default would let a query be embedded
  with a different model than the corpus it is searched against, and cosine
  similarity across two embedding spaces returns plausible numbers with
  meaningless rankings — no exception anywhere. For the same reason
  `embedding_model` is immutable in practice: changing it invalidates every chunk
  in that KB.
- **Results are re-sorted by the API's `index` field**, not taken in response
  order, and the returned width is asserted per vector before anything is handed
  back. A silent misalignment attaches each chunk's vector to a different chunk —
  the single worst outcome available here, and completely invisible downstream.

Two smaller contracts: `embed()` refuses a batch over `_MAX_EMBEDDING_BATCH`
(2048) rather than splitting it, because a split would make one `EmbeddingResult`
cover several HTTP calls and break the one-result-per-call shape the module keeps
— batching belongs to the ingestion pipeline, which knows document boundaries.
And cost is computed from the **requested** model id rather than the echoed one
(the reverse of `_build_result`), so an unrecognized echoed variant cannot throw
away a batch of vectors already paid for and successfully received.

`SUPPORTED_EMBEDDING_MODELS` is exported for the KB-creation schema to validate
against when that module is built — `embedding_model` should not accept free text.

**Not verified against the live API.** Written with Docker down and no OpenAI key
present; there are no tests for it yet and `embed()` has never been called. The
rates in `_EMBEDDING_MODELS` carry the same hand-maintained staleness caveat as
`_MODEL_PRICING`.

## Knowledge base + ingestion pipeline (landed 2026-08-15)

`knowledge_base` went models-only → real. `/api/v1/knowledge-bases` (CRUD +
documents + chunks), `src/core/{storage,document_text}.py`,
`src/workers/document_tasks.py`, migration `20260815_kb_ingestion`.
**This is the first code that touches MinIO, and `ingest_document` is the first
task ever registered on `worker_documents`** — that container had consumed
`-Q document_processing` with an empty registry since the initial commit.

Proven end to end against the live stack: `curl -F file=@ap-policy.pdf` → 202 →
worker extracts, chunks, embeds → `indexed` with `page_count`, chunks carrying
1536-d vectors readable through the API.

- **Two files live in `core/`, not in the module.** `storage.py` and
  `document_text.py` are infrastructure and pure logic respectively; the
  five-file module convention has no slot for either, and `llm_client.py` /
  `encryption.py` are the precedent. `document_text.py` in particular is the
  code most worth testing hard, and it has no DB, no network and no storage so
  the tests need no mocks.
- **Deduplication happens at UPLOAD, not only at ingest.** The first
  implementation only skipped when re-ingesting the *same row*, which is the
  retry case and not the one that costs money. Re-uploading a file creates a new
  row, and during development that happens constantly. `upload_document` now
  hashes the bytes (already in memory) and returns the existing indexed document
  with **HTTP 200** instead of 202, storing nothing and embedding nothing.
  `ix_documents_kb_content_hash` exists for that lookup. The per-row skip in the
  task is kept as well — it covers redelivery.
- **`document_chunks` has no `organization_id` and is not in the RLS policy
  set.** There is nothing for a policy to filter on, so the join through
  `documents` in `KnowledgeBaseRepository.list_chunks` is the ONLY defence, not
  defence-in-depth. `test_chunks_are_isolated_between_orgs` pins it.
- **`DocumentChunkResponse` must never serialise `embedding`.** 1536 floats per
  chunk makes a page of chunks a multi-megabyte payload of data no client can
  use — the vector's only consumer is the cosine query inside Postgres.
- **`passive_deletes=True` on the KB relationships is load-bearing, not
  tidiness.** Without it SQLAlchemy loads the children on delete and sets their
  FK to NULL *before* the DB cascade can fire, which is a `NotNullViolationError`
  because those columns are NOT NULL. Deleting a knowledge base failed outright
  until it was set; a test caught it.
- **The API default embedding model is `-small`; the COLUMN default is
  `-large`.** Deliberate, not a mismatch to fix. Both are requested at 1536 dims,
  so they are interchangeable in the schema and the shared HNSW index; -small is
  6.5× cheaper and the development loop re-indexes the same corpus repeatedly.
  `embedding_model` is absent from `KnowledgeBaseUpdate` under `extra="forbid"`:
  changing it invalidates every stored chunk, and re-embedding on a PATCH would
  be a silent unbounded spend.
- **No OCR, and the consequence is handled rather than ignored.** A PDF that
  yields no extractable text raises `UnextractableDocumentError` instead of
  indexing zero chunks. A document that silently indexes to nothing is a
  knowledge base that answers "I don't know" forever with nothing explaining why.
- **Chunking packs paragraphs, it does not slide a token window.** A window that
  cuts mid-sentence embeds a fragment whose meaning is neither neighbour's. An
  oversized paragraph falls back to a token split. **No chunk may be empty** —
  `embed()` raises on whitespace-only input and raises for the *whole batch*, so
  one blank chunk fails an entire document.
- **`_run_async` moved to `workers/async_bridge.py`** so `graph_tasks` and
  `document_tasks` share one implementation. `graph_tasks._run_async` is kept as
  an alias — the name appears throughout that module and in the worker-invariants
  section above. Behaviour unchanged.
- **Workers do NOT bind-mount `src/`; only `api` does.** A new task module is
  invisible to `worker_documents` until the image is rebuilt, and the symptom is
  a task missing from the `[tasks]` list at boot with no error anywhere. Hit
  while wiring this up. `docker compose build worker_documents` after any change
  under `src/workers/`.

## Deliberate design decisions (not bugs)

- `compile_graph()` bypasses the Redis compiled-graph cache entirely when
  a `checkpointer` argument is passed. Execution paths always compile fresh
  with a `PostgresSaver` checkpointer — this is intentional. The cache only
  benefits read-only paths (e.g. graph validation). Do not assume the cache
  helps execution performance.
- `aput_writes` in `PostgresSaver` uses a single atomic SQL UPDATE with
  PostgreSQL's JSONB `||` append operator (no read-modify-write). This is
  required to avoid a race with LangGraph's `AsyncBackgroundExecutor`, which
  submits `aput` and `aput_writes` as independent concurrent asyncio tasks.
- `http_request` tool nodes classify response status three ways, and the split
  is deliberate: **401/403** raise `ToolAuthenticationError` on the first
  attempt (a credential failure returned as node output is indistinguishable
  from a business 404 and would silently route the graph down a "not found"
  branch); **other 4xx** are returned as node output, because they are a
  definitive answer and Vol. 5 §1 routes on exactly that; **429 and 5xx** are
  retried and then raised as `ToolExecutionError`.
- A tool node's output carries `status_code` and `body` only — request and
  response **headers are never echoed**. That value lands in
  `node_executions.output`, which the Execution Viewer renders, and request
  headers routinely carry a bearer token. URLs are also query-stripped by
  `_safe_url()` before reaching a log line or an error message, since
  `?api_key=...` is a common auth pattern and tool errors land in
  `workflow_runs.error`. `test_http_request_output_never_includes_headers`
  pins this; don't "helpfully" add headers to the snapshot.
- `ToolExecutionError` / `ToolAuthenticationError` / `ToolNodeConfigError` are
  in `_NON_RETRYABLE` in `graph_tasks.py`. `tool_handler` already retried the
  call 3x, and this matters more for tools than for LLM calls: a mutating tool
  re-driven by a Celery retry could post the same journal entry four times.