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
  downstream of a `human_approval` node in the graph — this is enforced at
  the compiler level, don't bypass it.

## Known temporary gaps (don't silently "fix" these — they're deliberate)

- `agent_id`/`tool_id`/`prompt_id` references inside node `config` are
  stored as opaque UUIDs with no FK validation, since those modules aren't
  built yet. Compiler logs a warning, doesn't block.
- `agent`/`tool`/`subgraph` node handlers are stubs that raise
  `NodeNotImplementedError` if actually invoked.

## Known gaps to fix (not deliberate — found during verification, real
   bugs to address during the Celery/execution phase)

- `human_approval_handler` (`src/graphs/node_handlers.py`) writes its
  decision to a FIXED key, `node_outputs["human_approval"]`, instead of
  keying by the node's actual `node_key`. This silently collides the
  moment a graph has two or more `human_approval` nodes — the second
  overwrites the first. Fix this before building real execution on top of
  it.
- `node_executions` table exists in the schema but nothing writes to it
  yet. LangGraph's checkpointer does not populate this automatically —
  the execution engine needs an explicit hook (post-superstep write or
  callback) to populate it for the audit trail.
- `compile_graph()` bypasses the Redis compiled-graph cache entirely when
  a `checkpointer` argument is passed (see root CLAUDE.md's build-status
  note) — this needs a deliberate design decision, not an assumption, once
  execution work starts.