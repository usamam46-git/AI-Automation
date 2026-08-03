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
`billing` (stub), `integrations` (stub), `webhooks` (stub), `settings`
(stub).

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
- Any tool/node that mutates external state (ERP writes, payments) must sit
  downstream of a `human_approval` node in the graph (Vol. 4 §4.3).
  **DOCUMENTED TARGET, NOT YET ENFORCED** — this file previously claimed the
  compiler enforced it; it does not. No code in `src/graphs/compiler.py` or
  `validate_graph_structure()` checks upstream approval today. Scheduled for
  the next backend phase; until it lands, treat it as a rule authors must
  follow manually, and do not rely on it as a safety net.

## Known temporary gaps (don't silently "fix" these — they're deliberate)

- `tool_id`/`prompt_id` references inside node `config` are stored as opaque
  UUIDs with no FK validation, since those modules aren't built yet. Compiler
  logs a warning, doesn't block.
- `tool`/`subgraph` node handlers are stubs that raise
  `NodeNotImplementedError` if actually invoked.
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