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
- **The suite must need NOTHING but Postgres and Redis.** Those are the only two
  services `.github/workflows/ci.yml` provides — there is no MinIO and no broker
  there. `_stub_object_storage` (autouse, added 2026-08-15) replaces every
  `core/storage.py` entry point with an in-memory dict, the same shape as
  `_stub_celery_dispatch`. It exists because nine upload tests passed locally
  inside the compose network and failed in CI, which is the exact failure mode
  this rule prevents.
  To check a change has not reintroduced a dependency, run with object storage
  pointed somewhere unroutable rather than trusting it:
  `-e MINIO_ENDPOINT=203.0.113.1:9000` (TEST-NET-3). A green run under that is
  proof; a green run on a dev machine is not.
  The stub is an in-memory store, not a mock returning a constant, so an upload
  followed by an ingestion round-trips the real bytes. `core/storage.py` itself
  is thin boto3 glue verified by hand against the live service.
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

## External systems: what is REAL vs MOCK (read before promising an integration)

Added 2026-08-23, after a review found that "ERP" appears throughout this
repo's docs while **no real external system had ever been called by this
platform**. Every phase to date was proven against systems we control — a mock
ERP returning `MOCK-<uuid>`, our own signed webhook, our own MinIO, our own
corpus — all of which can pass end to end, repeatedly, in a browser, through
real Celery workers, without exercising one third-party API. Keep this table
honest; it is the fastest way for a reader to avoid the same wrong conclusion.

| Capability | State |
|---|---|
| `http_request` tool | **Real.** Outbound httpx, retries, redirects, URL templating, query params, encrypted credentials. |
| `erp_connector` tool | **MOCK.** No network call, ever. Returns `MOCK-<uuid>`. It exists to prove the mutating-approval mechanism, not to talk to an ERP. |
| `knowledge_search` tool | Real (internal — pgvector). |
| `python_function` / `mcp` | Rejected by name at create. |
| Inbound webhook trigger | Real, HMAC-verified. |
| Outbound webhooks (`webhooks` module) | Stub. Nothing delivers. |
| Notifications | Stub. `worker_notifications` boots with an empty task registry, so **every Vol. 5 HR workflow's terminal `Notify` step has no implementation**, and there is no `notify` NodeType. |
| Purpose-built ERP/HR adapters | Do not exist. An integration today IS an `http_request` registry tool. |

**Connecting to a real ERP means registering an `http_request` tool**, marking
it `is_mutating`, and putting a `human_approval` node upstream. That path works
and is proven live. `erp_connector` is not that path and never will be.

## `http_request` — templating, query params and retry safety (2026-08-23)

Four gaps closed together. All four were invisible against the mock connector
and surfaced the moment someone asked what pointing at a real ERP would take.

- **The URL is a TEMPLATE.** `{placeholder}` segments filled from
  `url_fields: {name: "dotted.state.path"}`, validated **in both directions** at
  write time (`_url_template`) — an unfilled placeholder and a mapping with no
  placeholder are both 422s naming the offender. Before this the URL was
  entirely static, which made `GET /invoices/{id}` — the ordinary shape of a
  REST endpoint — unbuildable, and Vol. 5 §1's `erp.get_vendor` step
  unreachable against a real system.
  **Every substituted value is `quote(..., safe="")`.** That is a security
  property, not tidiness: state is model output and webhook payload, so a value
  of `../../admin?x=1` must become one inert path segment rather than an SSRF
  primitive handed to whoever can influence a trigger. A placeholder resolving
  to `None` **raises** — a URL with a hole in it addresses the wrong resource,
  and on a mutating tool that means writing to the wrong record.
- **Query parameters exist** (`params` static + `params_fields` state-resolved),
  passed to httpx as `params=` so encoding is the transport's job and
  `_safe_url` keeps working. **A value resolving to `None` is DROPPED**, unlike
  a URL placeholder: an unset filter means "don't filter", while a missing path
  segment changes which resource is addressed.
- **A mutating call with no idempotency guarantee is NOT retried when the
  outcome is unknown.** `_may_retry` is the whole rule. Before this, every
  `http_request` node retried 3× on any timeout or 5xx — so a
  `POST /journal-entries` the ERP committed and then failed to acknowledge
  inside the timeout was posted **three times**, with nothing reporting a
  duplicate. Replays now happen only when the request provably never landed:
  `httpx.ConnectError` / `ConnectTimeout` (note `ConnectTimeout` is under
  `TimeoutException`, **not** under `ConnectError`, so it must be listed
  explicitly — its sibling `ReadTimeout` is the dangerous one) and HTTP 429,
  where the server explicitly reports it did not process. **5xx is deliberately
  absent**: a 500 can be raised after a commit.
  This hazard was already understood **one layer up** — `graph_tasks._NON_RETRYABLE`
  carries `ToolExecutionError` precisely so a Celery retry cannot "post the same
  journal entry four times" — and its justification reads *"`tool_handler`
  already retried the call 3x"*, treating that 3× as the safe baseline it was
  not. The reasoning simply had not been applied to the adjacent loop.
  Read-only tools keep the full retry budget; replaying a GET costs only time.
- **`idempotency: {"header": ...}` is an ASSERTION BY THE AUTHOR** that the
  target endpoint dedupes replays, and it is what re-enables retries on a
  mutating write. The key is `uuid5(namespace, "{run_id}:{node_key}")` —
  deterministic, so it is stable across the retry loop **and** across a Celery
  redelivery of the same leg (remember `_stream_graph` runs once per LEG). The
  header name is configurable because there is no standard one, and a key sent
  under a header the server ignores is worse than no key: it looks like a
  guarantee and is not one. `_IDEMPOTENCY_NAMESPACE` is fixed forever — changing
  it changes every key ever sent, the one thing an idempotency key must not do.
  **It is NOT in `NODE_OVERRIDABLE_KEYS`**: it is a claim about a server the node
  does not own.
- `url_fields`, `params` and `params_fields` **are** node-overridable — per-usage
  wiring, in the same sense as `body_fields`. A node can only fill placeholders
  the registry's template already declares, so it cannot re-point the host.

### Encrypted tool credentials — `tools.secrets_encrypted`

Migration `20260823_tool_secrets`. Until this, a registry tool's API key lived in
`tools.config` as **plaintext JSONB** and was returned verbatim by every read
endpoint. It never leaked in transit (`_audit_input` drops headers, node output
carries `status_code`/`body` only) — the exposure was at rest and over the API:
`pg_dump`, replicas, backups, and anyone holding `tool:read`. `models.py` made it
worse by describing the column as holding an *"auth reference"*, which is what the
design should have been and was not.

- Same scheme as the BYOK OpenAI key (`core/encryption.py`, AES-256-GCM), not a
  second one. **The same rotation consequence applies**: rotating
  `INTEGRATION_ENCRYPTION_KEY` destroys these values rather than degrading them.
- **`secrets` is write-only; `secret_keys` is the only echo.** There is no code
  path that decrypts and returns a value over HTTP, even to the owning org —
  exactly the rule `IntegrationStatusResponse.last_four` follows.
- **Referenced from config as `{{secrets.<name>}}`** and substituted in
  `resolve_node_configs`, i.e. at run start in the worker. The decrypted value
  exists in that process's memory for the run and nowhere else.
- **A reference to a secret that does not exist is a 422 at WRITE time**, and so
  is removing a secret a config still references. Catching it later would surface
  as a 401 from the vendor, indistinguishable from a revoked key.
- **An unknown name at run time is left as the literal placeholder**, never
  blanked. `Authorization: Bearer ` earns a 401 that reads as a revoked
  credential; the literal makes the cause obvious in the error the server returns.
- **`decode_secrets` returns `{}` on a decrypt failure rather than raising**, and
  logs it. A rotated key breaks every tool in the org at once, and raising would
  take down the tools LIST endpoint — the one screen an author needs in order to
  re-enter the credentials. It fails at run time instead, which is both louder and
  better placed.
- **PATCH replaces the whole map.** Omit `secrets` to leave it untouched; send
  `{}` to clear it. The dialog therefore only sends the field when the author
  actually edited it, or an unrelated rename would wipe every credential.
- `Tool.secret_keys` is a **model `@property`** (the `Workflow.current_version_number`
  precedent) with a deferred import, because `service.py` imports `models.py`.

### `resolve_field_path` indexes into lists (2026-08-23)

`condition_eval.py`. Sequences are traversed by integer index, negatives counting
from the end, so `node_outputs.get_vendor.body.data.0.id` reaches into a
list-shaped response. Before this the path stopped dead at the list and returned
`None` — and `{"data": [...]}` is the single most common shape a REST API
returns, so a real endpoint's payload was unreachable from the condition DSL, an
agent's `input_fields` and a tool's `body_fields` **all at once**, since all three
resolve through this one function. A dict is always traversed as a dict even when
the key looks numeric; strings are not indexable.

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
- **The tick's select MUST override `Workflow.current_version`'s eager load,
  and forgetting it silently stops every scheduled workflow** (2026-08-22).
  That relationship is `lazy="joined"` so `current_version_number` can be
  serialized on workflow list/detail responses, which means an eager LEFT OUTER
  JOIN is bolted onto every Workflow query that does not opt out. Postgres
  rejects `FOR UPDATE` on the nullable side of an outer join outright
  (`FeatureNotSupportedError`), so `dispatch_due_schedules` raised before
  dispatching anything — a total, silent outage of cron triggers, and 10 red
  tests in CI. The statement now carries
  `.options(lazyload(Workflow.current_version))`; it reads the
  `current_version_id` **column** and never the relationship. Any new row-locking
  query over `Workflow` needs the same option — do not "fix" it by dropping the
  eager load, which is what the response path depends on.
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

**`actor_email` is joined, not stored** (added 2026-08-18 with the audit-log
UI). `AuditLogRepository.list_by_org` returns `(AuditLog, actor_email)` pairs
from a LEFT OUTER JOIN whose onclause is
`and_(AuditLog.actor_type == "user", AuditLog.actor_id == User.id)`. Both halves
matter: `actor_id` is **polymorphic** (models.py — users.id *or*
agent_sessions.id depending on `actor_type`), so there is no FK to declare and a
bare `actor_id == User.id` join would match an agent session id against a user
id if the two ever collided. `agent` and `system` rows resolve to NULL by
construction, which is correct. `AuditService.list_logs` consequently returns
`AuditLogResponse` objects rather than ORM rows — `actor_email` is not an
attribute on `AuditLog`, so the router's `from_attributes` validation has
nothing to find. A `user` row with a null `actor_email` means the user was
deleted; the frontend renders a short id for it, deliberately not "Unknown".

**Two ORM identity-map traps were found writing this** — both produced a
*stale* read, and both will recur if you reach for the same shape:
`.returning(Model)` resolves to an instance already in the session's identity
map rather than refreshing it from the RETURNING row. So `get_by_type()` before
`upsert()` makes the upsert hand back the OLD `last_four`
(`IntegrationRepository.exists_by_type` exists solely to avoid this — it selects
a scalar column, which does not populate the identity map), and reading
`workflow.webhook_secret_encrypted` *after* `repository.update()` yields the new
value. Capture before-state before the write.

## Members + invitations (landed 2026-08-18)

Vol. 3 §10. Before this, `org_memberships` was written by **exactly one line in
the whole codebase** — `AuthService.register` — so every user was the sole Owner
of their own organization and Editor/Approver/Viewer had never been held by a
real user outside the test suite. `member:invite`/`member:remove` existed as
permission strings that gated nothing.

The `organizations` module went models-only → real: `{schemas,repository,service,
router}.py` under `/api/v1/organizations`. Migration `20260818_org_members`.
**Not a new module** — members belong to the org domain, and `organizations`
already existed as a directory.

- **`org_memberships.user_id` is now NULLABLE, and `invited_email` was added.**
  An invitation to an address with no account has nothing to point at and must
  still appear on the roster. This is safe **only because** every permission
  path already filters `status = 'active'` (`require_permission`,
  `AuthService.switch_org`) — a pending row grants nothing anywhere. Do not add
  a permission path that forgets that filter.
- **`uq_org_membership (organization_id, user_id)` does NOT constrain pending
  invitations** — Postgres treats NULLs as distinct. `uq_org_pending_invite`, a
  partial unique index on `(organization_id, lower(invited_email)) WHERE user_id
  IS NULL`, is what stops two invitations to one address.
- **Invite tokens and access tokens are signed with the SAME key**, so they are
  separated deliberately and in two ways: a `typ` claim (`"invite"` vs
  `"access"`, checked on both sides — `decode_invite_token` rejects a non-invite
  and `get_current_user` rejects a non-access), and the invite carrying **no
  `sub`, `user_id` or `jti`**. Either alone would do; both are cheap. If you add
  a claim to one kind, re-read this. `test_an_invite_token_is_not_usable_as_an_access_token`
  is the guard.
- **Invitations are stateless but revocable.** The token names a membership row
  that must still be `status='invited'`, so deleting the row or accepting it
  makes the token inert with no blocklist. That is why revocation is a plain
  DELETE.
- **An invitation is addressed to a person, not to whoever holds the link.**
  Both accept paths compare the token's `email` claim to the authenticated (or
  registering) user's address and 403 on a mismatch. Without it a forwarded link
  is a bearer credential for joining someone else's org.
- **Every invitation failure returns ONE identical 400** — bad signature,
  expired, revoked, already accepted. Same anti-enumeration reasoning as the
  webhook trigger's uniform 401; the preview endpoint is unauthenticated.
- **The last active Owner cannot be demoted, suspended or removed (409).** An
  org with no active Owner has nobody holding `"*"`, and every repair path is
  itself Owner-gated — it is unrecoverable without database access. The count is
  `status='active'` only: a suspended or invited Owner administers nothing.
- **Nobody may change their own role or status (409).** Self-elevation is the
  obvious half; the other is that an Admin cannot demote themselves into a state
  they cannot undo.
- **`Owner` is absent from `ASSIGNABLE_ROLES`, in both directions.** Ownership
  transfer has different consequences and is a separate, unbuilt operation.
- **Role and status changes MUST invalidate the permission cache.**
  `require_permission` reads Redis before the database, so a change that skips
  `invalidate_permissions_cache` is a change that does not take effect until the
  cache expires. `test_suspending_a_member_revokes_access_immediately` pins it.
- **`member:read` is NOT in `WILDCARD_READ_EXEMPT`** — knowing who your
  colleagues are is ordinary in-org information, unlike a BYOK key's last four
  or an audit row's client IP. Viewer reaches it through `"*:read"`; Admin,
  Editor and Approver hold it explicitly.
- **`seed_roles.py` alone is not enough when adding a permission.**
  `seed_system_roles` only INSERTs a role that is missing and never updates one
  that exists, so editing that file has no effect on any database that has
  booted once. The migration carries the same lists. Same pairing as
  `20260815_kb_ingestion`.
- **`POST /auth/register` grew an `invite_token` branch.** With it, no
  Organization and no Workspace are created and the existing `invited` row is
  filled in — dropping an invitee into their own empty org is precisely what
  invitations exist to prevent. `organization_name` becomes optional, enforced
  by a model validator.
- **`expand_permissions()` is the single place wildcards are resolved.** It
  sits in `core/permissions.py` beside `permission_granted` precisely because
  the two must agree; `test_expand_permissions_agrees_with_permission_granted`
  asserts that across every permission and every system role. The API returns
  the result as `effective_permissions` on both `RoleOption` and
  `CurrentMemberResponse`, which is what let the frontend **delete** its own
  copy of the wildcard branch — `WILDCARD_READ_EXEMPT` no longer exists in two
  languages. Do not reintroduce a client-side expansion.
  `ALL_PERMISSIONS` is hand-maintained so the vocabulary stays auditable by
  reading it; `test_all_permissions_is_complete` fails if a new constant is
  added and not listed. Unknown strings are **preserved**, not dropped — a
  custom role may name one, and under-reporting a grant is the one direction a
  permissions screen must never be wrong in.
- **`GET /organizations/roles` returns ALL system roles, Owner included**, with
  an `assignable` flag and ordered by power (`ROLE_DISPLAY_ORDER`), not
  alphabetically — sorting by name puts Approver above Editor and implies a
  hierarchy that does not exist. The reference table has to show the role that
  can do everything; the flag, not a short list, is what keeps Owner out of an
  assignment dropdown.
- `MemberRepository.get_membership_by_id_unscoped` is the **one** deliberate
  exception to org scoping, for the accept path alone: the invitee has no
  session in the target org yet. The org comes off the signed token and the row,
  never off the request. Same shape as `WorkflowRepository.get_by_id_unscoped`.

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

### Chunking quality: running headers and section boundaries (2026-08-30)

Two changes in `core/document_text.py`, no migration, no schema change. Driven by
measurement on a real 5-page hospital expense policy, not by intuition — the same
8 questions were embedded and scored before and after.

**The problem.** `pypdf` emits line breaks but almost never blank ones, so
`_PARAGRAPH_SPLIT` saw **one unit per page** and the packer welded a 16-section
policy into **4 chunks of ~455 tokens**, each covering three or four unrelated
sections. An embedding of that is an average of everything in it. Scores
compressed into a 0.28-0.57 band with a mean gap of **+0.031** between the right
chunk and the best wrong one — which makes any score floor arbitrary.

**The fix, and what it bought.** Strip running headers/footers, then split on
headings before packing: **11 chunks of ~130 tokens**, gap **+0.085**, and every
query improved. Live figures on that policy: "approval for PKR 35,000"
0.546 -> **0.692**, "above PKR 50,000" 0.570 -> **0.732**, and the top hit now
clears second place by ~0.20 instead of ~0.06. Smaller chunks also mean an agent
receiving `top_k=3` gets ~400 tokens of relevant policy instead of ~1,400 tokens
of mostly-unrelated text.

- **`_strip_running_lines` has three guards, and each closed a real failure found
  while building it.** (1) **Only the outermost `_RUNNING_LINE_EDGE` lines of a
  page are candidates** — digits are normalised so `Page 1`/`Page 2` collapse to
  one key, and without the positional limit that same normalisation eats body
  prose in the middle of a page. (2) **A line matching `_HEADING_LINE` is never
  furniture**, because headings are what the chunker now splits on and therefore
  the worst line in the document to lose. (3) **If the rule would remove more
  than half of any page's non-blank lines it bails entirely** — furniture is a
  couple of lines, so gutting a page means detection has failed, and noise is
  recoverable where missing content is not. Reachable on short pages, where the
  two edge windows overlap and every line is a candidate.
- **`_mark_headings` inserts a blank line before each heading** so the existing
  paragraph packer does the work; the packer itself only gained a section flag.
  Recognises `4. Expense Approval` and `## Approval`. The numbered form requires
  a capitalised word after the dot, so `1. 250,000` in prose is not a heading.
- **`MIN_SECTION_TOKENS` (110) merges a runt section forward** rather than
  letting a title page or a two-line clause become its own chunk — a very short
  chunk embeds to little and retrieves badly for everything.
- **Overlap is NOT carried across a section boundary** (`flush(carry_overlap=False)`).
  Overlap exists so a fact spanning an *arbitrary* cut stays retrievable from
  both sides. A heading is the author saying the topic ends there, and
  prepending the previous section's tail to a 130-token chunk would put ~45%
  foreign text into the very embedding the split exists to sharpen. Size-driven
  flushes keep overlap exactly as before.
- **Control characters are flattened to a SPACE, not to a guessed glyph.** PDF
  glyph tables map bullets and en-dashes onto unmapped code points and pypdf
  returns them verbatim — this policy's bullets and title dashes both arrive as
  U+007F. The byte says only "no glyph mapping"; inventing `-` or `•` would put
  characters in the corpus that are not in the document.

**What this does NOT fix, and the measurement says so.** One of the eight
queries still misses, before and after: *"Can an employee approve their own
expense claim?"* against *"Employees must not approve their own expenses."* That
is **negation**, not chunking — a question and its prohibition sit apart in
embedding space however the text is cut. The fix for that class is hybrid
retrieval; `ix_document_chunks_content_gin` (a GIN index on
`to_tsvector('english', content)`) has shipped **unqueried since the initial
schema** and is exactly what a lexical match on "approve their own" would use.
Do not attribute this miss to chunk size — that was tried and measured.

**Existing documents are NOT re-chunked, and re-uploading will not do it.**
Upload dedup is by `content_hash`, so the same file returns 200 and stores
nothing. **Delete the document from the KB, then upload it again.** (The
ingestion task's own skip needs *both* a matching hash and existing chunks, so
deleting just the chunk rows also forces a re-ingest — that is the cheap path
when re-measuring.) And remember `worker_documents` does not bind-mount `src/`:
**rebuild that image or ingestion silently keeps running the old chunker.**

## Retrieval / `knowledge_search` (landed 2026-08-16)

Days 6–7. Cosine search over the HNSW index that shipped in the initial schema
and had never been queried. **No migration** — the index and both vector columns
already existed. `POST /api/v1/knowledge-bases/{id}/search` (the retrieval
playground's endpoint, built ahead of its UI) and a `knowledge_search` tool type.

**It is a tool type, not a `NodeType`.** A node type would touch the backend
enum, `node_handlers.py`, the frontend `node-catalog.ts`, a config form AND
`lib/graph-validation.ts`, which reimplements the backend rules in a second
language. A tool type touches one dispatcher and inherits the registry picker
and `tool_executions` auditing already built.

Five things to know:

- **ORDER BY is the raw cosine DISTANCE, never the similarity score.** pgvector
  only matches an HNSW index on `<=>` ascending. Ordering by `1 - distance`
  descending is algebraically identical, returns the same rows in the same
  order, and silently degrades to a sequential scan over every chunk in the org.
  For the same reason the **score floor is applied in Python**, not as a SQL
  `WHERE` on the derived score — it trims at most `MAX_TOP_K` rows, so it is
  free there and costly in the query.
- **`build_chunk_search_stmt` is shared, and that is deliberate.** There are two
  callers with irreconcilable session types: the async API route, and the sync
  tool node (`tool_handler` runs inside a LangGraph superstep with nothing to
  await). Both execute the same statement object. Writing the query twice is how
  the sync copy quietly loses the `organization_id` filter — and the join
  through `documents` is the ONLY tenant defence chunks have.
- **`organization_id` comes from graph state, never from node config.** State is
  seeded by `initial_state_from_trigger` from the run row, so it carries the
  same provenance as a router's `get_current_org`; node config is author-typed
  text on a canvas. `test_the_organization_comes_from_state_not_from_node_config`
  pins it, and a missing org in state raises rather than searching unscoped.
- **`knowledge_search` emits `node_usage`; `http_request` and `erp_connector`
  still do not.** This breaks a previously-documented invariant on purpose —
  retrieval embeds the query and therefore spends real money, and a NULL there
  would make every RAG run under-report its own cost. The old rule described the
  two tools that existed, not a principle. Known limitation: `cost_usd` is
  `Numeric(12,6)` and a query embedding is ~$0.0000002, so the **per-node**
  column rounds to 0.000000. Tokens are recorded and `current_cost_usd`
  accumulates as a float before storage, so the run total is correct.
- **`knowledge_base_id` is registry-owned; only `query`/`query_fields` are
  node-overridable.** The KB is the retrieval TARGET — the direct analogue of
  `http_request`'s `url`, and swapping the corpus under a reviewed tool is the
  same hole in a different coat. `top_k`/`score_floor` are registry-owned too: a
  node quietly widening the floor to 0 turns curated retrieval into a noise
  generator that still looks approved. `is_mutating: true` is **rejected** on
  this type — a read that forces an approval gate upstream devalues the gate.

Two smaller notes. An empty hit list is a **result, not an error**: a corpus that
cannot answer a question should tell the agent so, not fail the run. And
`_default_search` imports the retrieval path **inside the call**, keeping the
`graphs → modules.knowledge_base → db.sync_database` edge out of import time —
`modules/tools/service.py` imports `node_handlers` for `validate_tool_config`,
and a module-scope import would drag a second DB engine into every process that
merely validates a config.

**Watch for default-argument binding here.** `client_factory: Callable = get_llm_client`
as a signature default binds the function object once at import, which defeats
monkeypatching and any later re-binding — it cost five failing tests during the
build. Both search paths take `None` and resolve inside the body instead.

## Hybrid retrieval — dense + full text (landed 2026-08-30)

`build_chunk_lexical_search_stmt` in `knowledge_base/repository.py`, `fuse_hybrid`
in its service. **No migration** — `ix_document_chunks_content_gin` shipped in the
initial schema and had never been queried once.

**It exists for one measured failure that chunking cannot fix: negation.** Asked
*"Can an employee approve their own expense claim?"* against a policy stating
*"Employees must not approve their own expenses"*, the answering chunk did not
reach the top 3. A question and its prohibition sit apart in embedding space
however the document is cut — re-chunking was tried first and moved that query
not at all. That phrase is a near-literal lexical match, which is what full text
is good at. On the Afaqhims corpus this took **top-3 from 7/8 to 8/8**; top-1 is
unchanged at 7/8, so this is a recall fix, not a ranking fix.

- **Two statements, fused in Python — not one clever query.**
  `build_chunk_search_stmt` must keep `ORDER BY <cosine distance>` with nothing
  else in the way or it stops matching the HNSW index, and folding a second
  ranking into it is the likeliest way for that to happen by accident.
- **The lexical leg also computes the cosine score**, though it orders by
  `ts_rank_cd`. So every hit carries a real, comparable `score` whichever leg
  found it and nothing downstream has to understand fusion. Costs a vector
  comparison over `candidate_depth` rows, which is not an index question.
- **RRF, not score blending.** Cosine is bounded and calibrated; `ts_rank_cd` is
  unbounded and depends on length and term density. Any weighted sum needs a
  normalisation that is a guess, and the guess silently decides retrieval
  quality. RRF reads only positions, so nothing needs normalising.
- **The returned `score` stays cosine similarity. Fusion governs ORDER only.**
  An RRF score is ~0.016 at rank 1, so returning it would make every stored
  `score_floor: 0.3` filter everything and would break the playground's cutoff
  line. This is the constraint to remember before "improving" the response.
- **The floor applies to the DENSE leg only; a lexical hit is admitted on its
  text match.** The floor is a statement about *semantic* similarity — the day-1
  probe put an answering clause at 0.51 and an unrelated one at 0.10. A literal
  phrase match is different evidence, and the negation case this leg exists for
  is precisely a chunk whose cosine is mediocre. Filtering lexical hits by cosine
  reintroduces the miss. Pinned by
  `test_a_lexical_only_hit_is_admitted_below_the_score_floor`.
- **The tsquery is OR, not AND, and that is the whole reason the leg works.**
  `plainto_tsquery` and `websearch_to_tsquery` both AND their terms, so a natural
  question asks for a chunk containing every one of `employe & approv & expens &
  claim` and routinely matches nothing. Lexemes come from `to_tsvector` (stemmed
  and stopword-filtered exactly like the indexed side), are `quote_literal`-wrapped
  because a lexeme may contain an apostrophe, and are OR-ed — letting `ts_rank_cd`
  discriminate instead of the matcher. An all-stopword query aggregates to NULL,
  `@@ NULL` is NULL, and the leg returns nothing: correct degradation, not an error.
- **`_CONTENT_TSVECTOR` must match the index expression character for
  character**, including the `'english'::regconfig` cast. Verified with EXPLAIN:
  `Bitmap Index Scan on ix_document_chunks_content_gin`. Drop the cast and you
  get a different expression and a sequential scan.
- **`candidate_depth` (4x top_k, min 20) is load-bearing.** Fusing only the top_k
  of each leg defeats the point — the chunk this rescues is one the dense leg
  ranks *poorly*, so it has to be inside the candidate window to be rescued.
- **Ties break on cosine, then chunk index**, so output is deterministic. An
  unstable retrieval order makes an agent's answer irreproducible for reasons
  nobody can see.

**Note on EXPLAIN at small scale:** with a 54-row `document_chunks`, Postgres
joins from `documents` first and uses neither the HNSW nor the GIN index — that
is the planner being right, and it was equally true of the dense leg before this
change. Both statements are written in the index-compatible form, so the plans
flip when the corpus justifies it. Do not "fix" a plan that says seq scan on a
toy corpus.

**No config knob, deliberately.** Hybrid is always on. A retrieval switch nobody
understands is worse than a decision, and `knowledge_search`'s node/registry
split already has enough surface.

## Notifications + the `notify` tool type (landed 2026-08-23)

`notifications` shipped in the initial schema and **nothing had ever written a
row**. `worker_notifications` consumed `-Q notifications` with an **empty task
registry** since the same commit. Vol. 5's three HR workflows (§14 Leave
Approval, §15 Payroll Validation, §16 Attendance) all terminate in a `Notify`
step, so a leave approval that approves and tells nobody was the whole HR story.

`modules/notifications/` went models-only → real (`schemas`, `repository`,
`service`, `router`), plus `src/workers/notification_tasks.py` and migration
`20260823_notify`. **All three worker containers now have a non-empty task
registry.**

- **`notify` is a TOOL TYPE, not a NodeType**, following the reasoning recorded
  for `knowledge_search`: a NodeType touches the backend enum, the dispatcher,
  the frontend node catalog, a config form AND `lib/graph-validation.ts`, which
  reimplements the backend rules in a second language. A tool type touches one
  dispatcher and inherits the registry picker and `tool_executions` auditing. A
  notification is also literally what a tool is — a side-effecting call to
  something outside the graph.
- **Delivery is ASYNCHRONOUS, and that is the design.** Vol. 5 puts Notify at the
  END of every HR workflow — after the leave is approved, after the payroll run
  is released. Delivering inline would let a Slack outage fail a run whose real
  work already succeeded and was already signed off by a human, which is the
  single worst place to put a third party. The node commits the row (the record
  of intent, same reasoning as `tool_executions`) and returns **`queued`, never
  `delivered`** — at that instant nothing has been sent. `notifications.status`
  is where the outcome lands.
- **The enqueue happens AFTER the commit.** The reverse races:
  `worker_notifications` is a separate process and can pick the task up before
  the transaction commits, then fail to find the row it was told to deliver.
- **`in_app` enqueues nothing** and is marked delivered on the spot: the row IS
  the delivery for that channel, and queueing a task whose only job is to set a
  column is a Redis round-trip to accomplish an UPDATE.
- **Only `in_app` and `webhook` have a transport.** `notifications.channel`
  documents a wider vocabulary (`email | whatsapp | slack`) that nothing
  delivers; those are rejected by name, the same rule `python_function`/`mcp`
  follow. `webhook` covers Slack, Teams and Zapier — all a POST with a JSON body
  — so a channel per vendor would be four spellings of one transport. Slack's
  `text` key is added alongside the structured payload; that is the one
  vendor accommodation and it is additive, not a code path.
- **`notify` rejects `is_mutating: true`.** A notification changes no external
  record, and Vol. 5 puts Notify *after* the gate — accepting the flag would
  demand a second approval to tell someone the first one happened. Same rule and
  same reasoning as `knowledge_search`.
- **A node cannot override `channel` or `url`.** Those are the transport, the
  direct analogue of `http_request`'s `url`; a node that could re-point a
  reviewed notify tool at its own webhook would exfiltrate whatever the workflow
  put in the payload. `title`, `user_id` and `body_fields` ARE overridable — the
  message and its recipient are per-usage.
- **Resolved values ride ALONGSIDE the body, never interpolated into it.** There
  is no template syntax anywhere in this codebase and this was not the place to
  invent one: `{}`-formatting author-supplied text against graph state is a
  format-string injection surface, and the condition DSL's whole design note is
  that state is *addressed*, never evaluated.
- **Webhook delivery retries a 5xx freely** — the reverse of the `http_request`
  idempotency rule, and for the same underlying reason: what matters is the cost
  of a replay. Re-POSTing a notification is at worst a duplicate message, never
  a duplicate journal entry. It IS idempotent on an already-`delivered` row,
  because `task_acks_late` means a crash after delivery causes a redelivery.
- **`status`/`error` exist so a failed delivery is queryable**, not just logged.
  `error` is query-stripped: an incoming-webhook URL carries its token there.
- **The read API is gated on AUTHENTICATION, not on a permission** — the one
  deliberate departure from `require_permission`. The endpoint is self-scoped by
  construction (`organization_id AND (user_id = me OR user_id IS NULL)`), so
  there is no privilege to check: a Viewer must see an alert addressed to them,
  and no role should see a colleague's. A `notification:read` would mean seeding
  it onto all five roles to grant what the query already limits.
- **There is no POST route.** A client-writable notification endpoint is a spam
  surface with no workflow behind it and nothing in the audit trail saying where
  the message came from. A test asserts 405.

## HR: Leave approval demo workflow (Vol. 5 §14, landed 2026-08-23)

`_leave_workflow` in `src/db/demo/graphs.py`, plus the `hr_notify_employee`
registry tool and `SAMPLE_LEAVE_REQUEST_PAYLOAD`.

- **§14's three HR tools are deliberately NOT invented.** `hr.get_leave_balance`,
  `hr.check_team_coverage` and `hr.approve_leave` have no endpoint behind them —
  there is no HR system wired to this platform — and three `http_request` rows
  pointed at a URL nobody has would publish and then fail on the first run. What
  is kept is §14's actual subject: **two independent exception paths converging
  on one outcome**, with the decision grounded in the company's own published
  handbook rather than the model's employment-law priors.
- **It decides and notifies; it does not write back to an HR system.** That is
  the honest state, pinned by a test so it cannot drift silently. Adding
  `hr.approve_leave` is one `http_request` registry tool marked `is_mutating`,
  slotted in front of `notify_employee` — at which point
  `validate_mutating_approval` starts *requiring* the two gates this graph
  already has. Nothing else about the shape changes.
- **No node is mutating, so the guardrail does not fire.** The two
  `human_approval` nodes are there because the POLICY asks for a manager, not
  because the validator forced them. Worth knowing before someone "simplifies"
  them away: load-bearing for §14, invisible to the validator.
- **The two conditions are separated by two non-condition nodes, and that is
  required.** Condition nodes cannot chain — the router attaches to the
  condition's PREDECESSOR — so two in sequence mis-route silently. Nothing
  validates this at publish (`Docs/shakedown-fixes.md` §K), so
  `test_no_two_condition_nodes_are_adjacent_in_any_demo_graph` asserts it across
  every demo graph.
- **Balance routes deterministically, coverage routes on a grounded agent.** The
  same asymmetry the invoice workflow draws: `balance_after < 0` is arithmetic
  and cannot misfire, while the notice/coverage decision is the handbook's §4.1
  doing real work.
- The sample payload is tuned to fire **both** gates in one run (8 days against a
  6-day balance, 9 days' notice against the handbook's 28). Raise the balance and
  push the dates out for the clean path.

## Run instrumentation + the builder's Test step (landed 2026-08-30)

Migration `20260830_run_instrumentation`. Four columns, all additive. Six
behaviours landed together, and **each replaced something that was silently
absent rather than merely imperfect** — which is why they are worth reading
before touching `_stream_graph` or the compiler.

- **`node_executions.input` was written as an unconditional `None`**, with an
  honest comment that `stream_mode="updates"` cannot see prior state. It still
  cannot. The fix is that handlers report their own resolved inputs on a
  `node_inputs` channel, exactly as they already report `node_usage` — an
  agent's `_build_agent_input` result, a tool's resolved `*_fields` maps. It is
  the VALUES, not the configured paths: the paths are already in
  `tool_executions.input`, and knowing a node was told to read
  `node_outputs.extract.total` is no help when the question is why the request
  carried a null. A `null` here is a mis-typed path made visible, and nothing
  else in the product reports one. **A tool with no field maps writes no
  `node_inputs` entry at all** — an empty dict on screen reads as a finding.
- **`node_executions.status` was written as an unconditional `"succeeded"`.** A
  raising node produced NO row, so `node_executions` had never contained a single
  `failed` row and nothing knew which node broke. The compiler's `_instrument`
  wrapper now **TAGS** the exception with `NODE_KEY_ATTR` and `_stream_graph`
  writes the row.
  **Tagging, not wrapping, and that distinction is load-bearing**: `_NON_RETRYABLE`
  classifies by exception TYPE, so a wrapper exception would make every config
  error look retryable and re-drive a mutating tool three more times. The
  exception is re-raised unchanged, so every existing `except` clause is
  unaffected.
  **LangGraph's own exceptions are left completely alone.** `human_approval_handler`
  suspends the graph by raising through `interrupt()`; tagging that would write a
  `failed` row for every approval gate. The check is on the exception's PACKAGE,
  not a class name, so a LangGraph upgrade that renames or re-parents
  `GraphInterrupt` cannot quietly break approvals.
- **`current_node_key` was written only at an interrupt, and then as the literal
  string `"human_approval"`** — which no graph with two gates could tell apart.
  The interrupt payload now carries `node_key`, and the column advances as each
  node completes. It names the node that **most recently finished**: updates-mode
  yields a chunk only after a node succeeds, so nothing can announce a node as it
  starts. The frontend infers "running" from that and labels the inference.
- **`latency_ms` was a whole-SUPERSTEP delta** measured in the stream loop, so
  two nodes running in one step were reported with an identical duration counted
  from the end of the previous step. `_instrument` measures the handler and
  reports on a `node_timings` channel; `started_at`/`completed_at` are that
  measurement. `latency_ms` is still written and is still the fallback for rows
  from before this.
- Both new channels are in `_BOOKKEEPING_CHANNELS`, so they are stripped from the
  output snapshot for the same reason `node_usage` is.

### The Test step — `POST /workflows/{id}/versions/{version_id}/test-run`

- **It runs the version named in the PATH, draft included.** That is the entire
  point: `POST /workflows/{id}/run` is always pinned to `current_version_id`, so
  the builder's old "Test run" ran the PUBLISHED graph and reported success while
  never testing the draft on screen.
- **`_compile_state_graph` gained `allow_draft`**, threaded from
  `workflow_runs.is_test`. The draft guard stays the default and is still what
  stops a production run executing an unpublished graph; only a run already
  flagged as a test can opt in. Forgetting this is not subtle — every test run
  raised `DraftVersionCompileError` until it was added.
- **It is a REAL run.** Same Celery task, same engine, same quota, same audit
  row, same money. Building a parallel dry-run engine was the alternative and
  would have meant a second implementation of the part most worth trusting.
  `is_test` exists only so the Executions list is not filled with the probes an
  author fires while wiring a node up — `include_test=true` brings them back.
- **A mutating node in the executed prefix is a 422 naming it**, unless the
  request carries `allow_mutating`. A test that posts a real journal entry is not
  a test. "Reachable" is read generously — everything except what is strictly
  downstream of the stop node — because the true executed set depends on
  conditions that need the run that has not happened yet.
  `_strictly_downstream` terminates on a cyclic draft, deliberately: a test run
  is exactly what someone reaches for **before** a graph is publishable.
- **`test_until_node_key` is read off the run row, not passed as a task
  argument.** A Celery signature change would strand any job already queued under
  the old one. It survives a resume, so approving a test cannot let it run past
  where it was told to stop.
- `human_approval` behaves exactly as in production — the run holds at the gate
  and is resumed through the normal endpoint. Honest, and it demonstrates the
  product's actual differentiator rather than skipping it.

### `GET /executions/{run_id}/status`

The polling shape: the run row plus node SUMMARIES, no `input`/`output`. The full
response re-sends every node's accumulated state snapshot on every tick, and the
builder's live overlay polls faster than the Execution Viewer does. It reuses
`get_run`'s query rather than adding a second one — the saving is in the RESPONSE,
which is where the cost was.

## HIMS — the first real external system (2026-08-30)

`src/db/hims_expense_seed.py`, `tests/test_hims_expense_graph.py`. Posts an
expense into **Afaqhims**, a live production hospital system. Read this before
editing either file; the failure modes here have a patient-facing organisation on
the other end of them.

```
docker exec -w /app aap_api python -m src.db.hims_expense_seed --email you@example.com
```

Idempotent. It creates `expense_policy_search` and `hims_notify_finance` but
**deliberately does not create `hims_create_expense`** — that row holds a live
credential, `secrets` is write-only with no read-back, and a seed script that
created it would either ship a production token in the repo or register a tool
that 401s. It verifies the existing row instead and refuses to build on one that
is not mutating, holds a literal credential in a header, or declares idempotency.

- **The credential was found in plaintext once, and the check exists because of
  it.** `tools.config` is plaintext JSONB returned by every read endpoint. The
  row had the JWT correctly in `secrets` AND copied verbatim into the
  `Authorization` header. Only `Bearer {{secrets.hims_token}}` is encrypted at
  rest; `_verify_create_expense_tool` now fails the seed on any header matching
  authorization/api-key/token that carries no `{{secrets.` reference.
- **There is NO idempotency block, and adding one would be a lie.** Afaqhims does
  not dedupe (confirmed with its owner). `_may_retry` therefore replays a failed
  POST only when the request provably never arrived — so an unacknowledged write
  is neither retried nor confirmed, and the recovery is to check HIMS by hand.
- **Money routes deterministically and the model never touches it.**
  `check_amount` compares `node_outputs.extract.amount_pkr` — a real number —
  against PKR 10,000. Only ONE predicate plus one catch-all leaves that node,
  because the condition DSL has no AND and an ordered ladder is unsafe here
  (`save_draft` re-inserts every edge in one transaction, so `created_at` ties and
  the tiebreak is a random UUID). The 10,001–50,000 versus above-50,000 split is
  carried to the reviewer in `required_approval_level`, not by routing.
- **The amount exists twice on purpose.** `amount_pkr` is a number for the
  condition; `expense_amount` is a string because the API takes `"200"`. Both come
  from one extraction and a test pins that neither drifts.
- **A missing date is a POLICY violation, not an engine special case.**
  `body_fields` resolves an unreachable path to `None` and **sends it** (unlike
  `params_fields`, which drops the key), so a dateless payload would put
  `"expense_date": null` into a hospital ledger. `extract` still refuses to invent
  a date — a fabricated one is worse than a missing one, and "default to today" is
  wrong whenever the expense was incurred on another day. Instead `assess` is told
  that a missing date or amount is a breach, which the policy itself says it is,
  so it surfaces as a named violation at the gate. **There is no clock in graph
  state at all** (`initial_state_from_trigger` seeds no timestamp), so "use now"
  is not buildable without a backend change plus a timezone decision.
- **`shift_id` is hard-coded to 6 / "Evening".** The only pair evidenced by a real
  request. Every expense this files is stamped Evening shift regardless of when it
  happened — wrong data, not a failure, so nothing errors. Pinned by a test so
  replacing it is deliberate.
- **`expense_id` is NOT unique in HIMS.** Two expenses returned `srl_no` 6164 and
  6165 carrying the same `expense_id` "EXP2028". `notify` reports both, `srl_no`
  first, because it is the only value that identifies a row.
- **Both branches are gated, which is stricter than the validator requires.**
  `validate_mutating_approval` is ∃-semantics, so deleting ONE gate still
  publishes while that branch posts unattended — pinned as an explicit caveat in
  `test_removing_ONE_gate_still_publishes_and_that_is_a_known_limit`, alongside a
  test asserting every path into the write passes a gate.

### The bring-up route — reuse it for the next real system

Never point a new mutating tool at a live host first. What worked:

1. Run a local echo container on the compose network (`--network infra_default`)
   and PATCH the tool's `url` at it. Nothing leaves the machine.
2. Run past the gate with `allow_mutating`, then read the captured request. The
   check that matters is that `Authorization` carries the **decrypted** token and
   not the literal `{{secrets.…}}` — that substitution had never executed, and its
   failure mode against a live API is a 401 that reads as a revoked credential.
3. Only then restore the real URL and run once with a small amount.

Note the harness blocks an agent from approving a run at a gate, which is correct
— that decision is the product's whole point. A human runs the approve step.

## Demo seed — `src/db/demo/` (landed 2026-08-17)

Build-plan days 10–12. Four Markdown corpus documents, three registry tools, three
published workflows, and a webhook-signing helper. Nothing in the application
imports any of it.

```
docker exec -w /app aap_api python -m src.db.demo.seed --email you@example.com
docker exec -w /app aap_api python -m src.db.demo.send_invoice
```

- **It lives under `src/` for one concrete reason.** `infra/docker-compose.yml`
  bind-mounts `apps/api/src` into `api` and nothing else, so a corpus document or
  a prompt edited on the host is live in the container immediately. A sibling
  `apps/api/demo/` would need an image rebuild for every wording change. This is
  the same constraint that bites `src/workers/` in the other direction — workers
  do *not* bind-mount, so a new task module still needs a rebuild.
- **It seeds into an EXISTING org, resolved from `--email`.** Minting a throwaway
  demo org was rejected: the seeded data would be invisible to whoever is already
  logged in, and the org's BYOK key would not travel to it. The script refuses to
  guess — no user, no membership, or more than one active membership are all hard
  failures naming the ambiguity.
- **Every write goes through the services, never the repositories.** That is the
  point of the script: a graph that seeds is a graph that publishes, and a config
  that seeds is one `_tool_config` accepts. Writing rows directly would let it
  create demo data the product itself would reject. The consequence is that it
  must `commit()` explicitly between phases, because services flush and the
  FastAPI session dependency is what normally commits.
- **Idempotent, and the graph-signature check is the load-bearing half.** KBs,
  tools and workflows are looked up by name; uploads dedup on content hash inside
  `upload_document`. But a published version is immutable, so "already correct"
  has to be decided by comparing the published graph against the desired one —
  without `_graph_signature`, every re-run would publish a byte-identical version
  N+1 and the history would fill with noise.
- **`SET app.current_org_id = :param` does not work.** `SET` is utility syntax and
  takes no bind parameters; asyncpg sends `$1` and Postgres answers "syntax error
  at or near $1". Use `SELECT set_config('app.current_org_id', :org, false)` — an
  ordinary function call, which parameterises normally. Never string-interpolate
  it instead; that is an injection site. The third argument is `false`
  (session-scoped) because the script commits repeatedly and `SET LOCAL` dies
  with its transaction.
- **Dispose the engine inside the same event loop.** `finally: asyncio.run(engine.dispose())`
  after `asyncio.run(_seed(...))` floods the exit with `Event loop is closed` and
  `attached to a different loop` — asyncpg connections are bound to the loop that
  opened them. This is exactly what `workers/async_bridge.py` exists to solve;
  the script's `_run()` wrapper is the same fix in miniature.
- **The webhook secret is written to `/tmp/orkest-demo.json`, mode 600, never
  under the repo.** It is a live credential that starts production runs with no
  login, and `src/` is a bind mount of the working tree — a secret written there
  is one `git add -A` from being committed. It is returned exactly once at
  generation and is not readable back, so a seed re-run on a workflow that
  already has one reports that honestly and points at `--rotate-webhook-secret`
  rather than pretending.
- **`tests/test_demo_graphs.py` runs the demo graphs through the REAL validators**
  — `validate_graph_structure`, `validate_mutating_approval`, `_agent_config`,
  `_tool_config`, `evaluate_condition` — with no database and no network. Node
  `config` is `dict[str, Any]` all the way down, so nothing else connects these
  hand-written blobs to the handlers that consume them. It also reproduces
  `resolve_node_configs`' merge (reading `NODE_OVERRIDABLE_KEYS` rather than
  restating it), because a raw demo tool node carries only `tool_id` and
  `_tool_config` would correctly reject it; what has to be valid is the merged
  config that actually reaches the handler.

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
- **`http_request` follows redirects** (`get_http_client`, `follow_redirects=True`,
  `max_redirects=5`, both overridable). Added 2026-08-21 as a bug fix, not a
  preference: httpx defaults to NOT following, unlike requests, and a 3xx is below
  500 and absent from `_RETRYABLE_STATUS`, so the classification below treated it
  as "a definitive answer from the server" and handed the redirect's HTML body to
  the graph as the tool's result. Found live — a node calling
  `api.frankfurter.app` stored a Cloudflare `301 Moved Permanently` page as an FX
  rate and the downstream agent reasoned over it with nothing reporting a failure.
  The residual edge is documented on the factory and is worth knowing: httpx
  strips `Authorization` when a redirect leaves the origin, but **not** a custom
  header such as `X-API-Key`, so a tool holding one should point at a
  non-redirecting URL. By the time the three-way split below runs, the status is
  always the final hop's.
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