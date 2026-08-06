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
versions/nodes/edges), `agents` (stub), `tools` (stub), `prompts` (stub),
`knowledge_base` (stub), `chat` (stub), `notifications`, `audit_logs`,
`billing` (stub), `integrations` (real for one type — BYOK `openai_api_key`,
see security section below; other integration types remain stub), `webhooks`
(stub), `settings` (stub).

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
  - **Fail-open on a typo** — `is_mutating` lives in free-form JSONB config, so
    a misspelled key silently skips the gate. `_tool_config` rejects a non-bool
    value at invoke time, which catches `"true"` but not `is_mutation`. A typed
    column would fail closed; revisit when the tools module lands.

## Known temporary gaps (don't silently "fix" these — they're deliberate)

- `tool_id`/`prompt_id` references inside node `config` are stored as opaque
  UUIDs with no FK validation, since those modules aren't built yet. Compiler
  logs a warning, doesn't block — except on a node already carrying inline
  config (`tool_type` for tools, `output_schema` for agents), where the id is a
  forward-compat no-op rather than an unresolved reference.
- `subgraph` node handler is still a stub that raises
  `NodeNotImplementedError` if actually invoked. `tool` is real as of
  2026-08-04.
- `tool` nodes carry their type and settings **inline** in node `config`
  (`tool_type`, plus `url`/`method`/`headers`/`body`/`body_fields`/
  `timeout_seconds` for `http_request`, or `action`/`payload`/`payload_fields`
  for `erp_connector`), rather than resolving `tool_id` against the `tools`
  table — the same deliberate temporary denormalization as `agent` nodes below,
  for the same reason (the tools module is models-only). A node carrying *only*
  `tool_id` raises `ToolNodeConfigError` at invoke time. Values reach the
  request via `body_fields`/`payload_fields`, `{destination_key: "dotted.state.path"}`
  maps resolved by the same `resolve_field_path` the condition DSL uses — the
  URL itself is static, with no interpolation yet.
- `erp_connector` is a **mock**: it makes no network call and returns
  `{"posted": true, "confirmation_id": "MOCK-<uuid>", ...}`. It exists so the
  mutating-tool mechanism can be proven before a real ERP adapter exists.
  It accepts both `create_journal_entry` (Vol. 2 §7.2's ERPConnector interface
  name, canonical) and `post_journal_entry` (Vol. 5 §5's diagram label), because
  the blueprint uses both spellings and both workflows must be buildable verbatim.
- Vol. 2 §7.2's other two tool types, `python_function` and `mcp`, are rejected
  by name — not silently accepted.
- `tool_executions` is still unwritten. Vol. 4 §4.3 wants a row written
  *before* a mutating call executes, as an audit trail of intent; today tool
  call details live only in `node_executions.input`/`output`, same as every
  other node type. That row belongs to the tools module when it lands.
- `agent` nodes carry their model/prompt/schema **inline** in node `config`
  (`system_prompt`, `output_schema`, `input_fields`, `model`, `temperature`,
  `max_tokens`) rather than resolving `agent_id` against `agents`/
  `agent_versions`. This is a deliberate temporary denormalization — the
  agents module is models-only, so there is nothing to look up. `agent_id` is
  accepted and ignored. When the agents module lands it should resolve
  `agent_id` into this same shape so neither `agent_handler` nor the Builder
  UI's node config panel has to change. A node carrying *only* `agent_id`
  raises `AgentNodeConfigError` at invoke time.

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