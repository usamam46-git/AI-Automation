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
`audit_logs`, `billing` (stub), `integrations` (real for one type — BYOK
`openai_api_key`, see security section below; other integration types remain
stub), `webhooks` (stub), `settings` (stub).

`src/graphs/` is separate from `src/modules/workflows/` on purpose — it
holds the LangGraph compiler (`compiler.py`), per-node-type handlers
(`node_handlers.py`), the safe conditional-edge evaluator
(`condition_eval.py`), and the Redis-backed compiled-graph cache
(`cache.py`). Graph *execution artifacts* are distinct from workflow
*metadata*.

`src/workers/` holds Celery app config (`celery_app.py`), the LangGraph
execution tasks (`graph_tasks.py`), and the PostgreSQL checkpoint saver
(`postgres_saver.py`). The `executions` module (`src/modules/executions/`)
owns `WorkflowRun` and `NodeExecution` models, schemas, repository, service,
and router.

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
  registry tools.
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