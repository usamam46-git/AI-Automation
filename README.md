# AI Automation Platform (AAP)

**Status**: Active Development  
**Current Phase**: Phase 5 — the loop is closed. You can register, draw a workflow on the canvas, publish it, trigger a run, watch it pause for approval, and approve it to completion **entirely through the UI** — never touching the API or reading a database row by hand. Next up: the `subgraph` handler, a real `tools` module, and the dashboard home.

## The End Goal

The **AI Automation Platform (AAP)** is a highly scalable, multi-tenant B2B SaaS platform designed to automate complex ERP, HR, and Financial System workflows. 

At its core, AAP combines **Autonomous AI Agents** with a **Visual Workflow Engine** (powered by LangGraph) and **Retrieval-Augmented Generation (RAG)** to create intelligent, automated pipelines that can securely interact with sensitive enterprise data.

### Key Capabilities Planned:
- **Visual Workflow Builder:** Drag-and-drop orchestration of LLM nodes, tools, and logic.
- **Agentic Framework:** Long-running, multi-step autonomous agents with memory, tool access, and dynamic routing.
- **Enterprise RAG:** Built-in Knowledge Base with hybrid search (HNSW pgvector + GIN keyword) and automated OCR ingestion pipelines.
- **Strict Multi-Tenancy:** Hardened Row Level Security (RLS) ensuring strict data isolation across organizations.
- **Robust Auditing:** Immutable, append-only audit trails for every material action.

---

## What We've Built So Far

We have completed the foundational **Database Schema and Migration Layer** (Volume 2 §1 - §3.8), the **Authentication & RBAC Layer** (Volume 2 §10 - §11), the **Workflow Engine data layer** (Volume 2 §3.2), the **Graph Compiler** (Volume 2 §6.1), the full **Workflow Execution Engine** — Celery task queue, LangGraph runtime, and a custom PostgreSQL checkpointer (Volume 2 §5, §6.3 - §6.5) — **real node execution** (agent nodes calling OpenAI with structured outputs, tool nodes making real outbound calls, and a publish-time guardrail against unapproved mutations), **BYOK credential storage** (Volume 2 §13), and the two frontend surfaces that make all of it usable: the **Visual Builder Canvas** (Volume 3 §4) and the **Execution Viewer** (Volume 3 §6).

**188 backend tests pass** (`cd apps/api && poetry run pytest`) with `ruff check` and `ruff format --check` clean, and **65 frontend tests pass** (`cd apps/web && npm test`) with `eslint`, `tsc --noEmit`, and `next build` clean. Both suites run on every push and PR via GitHub Actions (`.github/workflows/ci.yml`).

### Highlights:
1. **Docker Infrastructure:** Configured `docker-compose.yml` with `pgvector/pgvector:pg16` for PostgreSQL, alongside Redis and MinIO (S3 compatible object storage).
2. **SQLAlchemy ORM Models:** We mapped out 19 core tables divided across domains:
   - **Identity & Tenancy:** Users, Roles, Organizations, API Keys, Workspaces.
   - **Workflow Engine:** Workflows, Versions, Nodes, Edges, Runs, and Node Executions.
   - **Agents & RAG:** Agents, Agent Sessions, Agent Memory (`Vector(1536)`), Prompts, Tools, Knowledge Bases, and Document Chunks.
   - **Audit & Chat:** Immutable Audit Logs, Chats, Messages, and Notifications.
3. **Advanced Alembic Migrations:** 
   - Initial schema generation incorporating `pgvector` and `citext`.
   - Advanced manual indexes (HNSW for semantic search, GIN for full-text search, and composite B-trees).
   - Manually authored **Row Level Security (RLS)** migration enforcing tenant isolation policies across the entire schema via `app.current_org_id` context.
4. **FastAPI & Core Security Foundations:**
   - Established the FastAPI application structure and environment configuration using Pydantic Settings.
   - Implemented highly secure Authentication routes (`/register`, `/login`, `/switch-org`, `/refresh`, `/logout`).
   - Hardened JWT patterns: The opaque `refresh_token` is handled securely via an `httpOnly`, `Secure`, and `SameSite=Strict` cookie, whilst the `access_token` is sent back in the JSON body.
   - Used Argon2 for advanced password hashing.
5. **Redis Integration & Security Controls:**
   - Implemented an asynchronous connection pool leveraging `redis-py` (`aioredis`).
   - Implemented **Refresh Token Rotation** and a **JWT Blocklist** (by checking the `jti` claim).
   - Designed a highly-performant **Role-Based Access Control (RBAC)** permission dependency (`require_permission`) that pulls directly from a Redis cache to avoid hitting the database on every authenticated request.
   - Secured the public Auth routes with a Redis-backed Sliding Window **Rate Limiter** (`RateLimiter` dependency).
6. **Workflow Shell CRUD (`/api/v1/workflows`):**
   - Create, list, get, update, and soft-delete (archive) workflows scoped to organization and workspace.
   - Workspace ownership verified explicitly at the service layer (clean 404, not RLS-dependent).
   - Event bus hooks: `workflow.created`, `workflow.updated`, `workflow.archived`.
7. **Workflow Version Graph Storage (`/api/v1/workflows/{id}/versions`):**
   - Save/update draft graphs as a single atomic request (nodes + edges together, not per-node CRUD).
   - Structural validation at save and publish time: unique `node_key`, edge referential integrity, start/end nodes required, orphan detection, cycle detection.
   - Draft lifecycle: re-saving a draft replaces its nodes/edges in-place; publishing creates immutability; a new save after publish creates the next version number.
   - Publish sets `Workflow.current_version_id` and `Workflow.status = "published"` (PATCH cannot set status to published directly).
   - Dedicated `workflow:publish` permission (Owner/Admin only); `workflow:write` covers draft saves.
   - Event bus hooks: `workflow_version.saved`, `workflow_version.published`.
   - **Known gap:** `agent_id` / `tool_id` / `prompt_id` references in node `config` are stored as opaque UUIDs without FK validation (those modules don't exist yet).
8. **Graph Compiler (`apps/api/src/graphs/`):**
   - Translates published `WorkflowVersion` rows into LangGraph `CompiledStateGraph` objects.
   - Structured condition DSL on edges (`field` / `operator` / `value`) — safe dotted-path evaluation, no `eval()`.
   - `condition`-type nodes compile into `add_conditional_edges` routing (not executable graph nodes).
   - Real handlers: `start`, `end`, `human_approval` (uses LangGraph `interrupt()`; resume wiring lives in the Execution Engine — see point 9), plus `agent` and `tool` (see points 10 and 11).
   - Stub handler: `subgraph` raises `NodeNotImplementedError` if invoked.
   - Bounded process-local compiled graph LRU cache with Redis invalidation markers; invalidated on draft replace via `save_draft`. `COMPILED_GRAPH_CACHE_MAXSIZE` controls the per-process max size and defaults to `1000`.
   - Synchronous in-process test runner with LangGraph `MemorySaver` (unit tests); real execution always compiles fresh with the production `PostgresSaver` and deliberately bypasses the Redis cache — see point 9.
9. **Workflow Execution Engine (`apps/api/src/workers/`, `apps/api/src/modules/executions/`):**
   - **Celery task queue** (`workflow_execution`, Redis-backed broker, no result backend — run state lives in Postgres, not Celery). `task_acks_late` + `task_reject_on_worker_lost` so a crashed worker's task is redelivered, not lost. `execute_workflow` / `resume_workflow` tasks retry up to 3 times with exponential backoff (1s/2s/4s) on transient errors, and dead-letter (mark the run `failed`) on non-retryable errors or retry exhaustion.
   - **Custom `PostgresSaver` checkpointer** — implements LangGraph's checkpoint protocol directly against `workflow_runs.checkpoint_state` (JSONB), so no separate checkpoints table is needed. Fixed a real race condition: LangGraph's `AsyncBackgroundExecutor` submits `aput()` and `aput_writes()` as independent, unchained concurrent tasks, so a naive read-modify-write in `aput_writes` could clobber a newer checkpoint written by a concurrent `aput`. Fixed with a single atomic SQL `UPDATE ... jsonb_set(... || ...)` — no Python-side read at all.
   - **Full execution lifecycle:** `pending` → `running` → (pauses at a `human_approval` node via LangGraph `interrupt()`, status `waiting_approval` with a readable `interrupt_payload`) → approve (resumes the graph, `running` → `completed`) or reject (terminal `rejected`, no further graph execution) → or `failed` on unrecoverable error.
   - **HTTP API:** `POST /workflows/{id}/run` (trigger), `GET /executions/{id}` (poll status + node history), `POST /executions/{id}/resume` (approve/reject a waiting run). Resuming a run that isn't `waiting_approval` returns 409, not a silent no-op.
   - **RBAC:** three dedicated permissions — `workflow:execute`, `execution:read`, `execution:approve` — layered independently from `workflow:write`. Owner/Admin hold all three; Editor holds neither (can build workflows but not run them); Approver holds only `execution:read` + `execution:approve`.
   - **Worker-restart resilient:** a completely fresh worker process, with a brand-new `PostgresSaver` instance and zero in-memory state, can resume any in-flight run purely by loading its checkpoint from Postgres.
   - **Audit trail:** append-only `node_executions` rows per node invocation, idempotent against Celery retries (checked via a `(run_id, node_key, attempt)` succeeded-row lookup before insert).
10. **Agent Node Execution (`apps/api/src/core/llm_client.py`):**
    - Single OpenAI wrapper handling structured outputs (strict JSON Schema), token counting, cost calculation, and a LangSmith tracing hook.
    - Hand-rolled retry with exponential backoff (1s/2s/4s) on transient provider errors only — rate limits, timeouts, connection failures, 5xx. Auth errors and malformed schemas surface on the first attempt.
    - `agent` nodes call the model with only the state fields they declared in `input_fields` (dotted paths resolved by the same evaluator the condition DSL uses), and persist real `tokens_prompt` / `tokens_completion` / `cost_usd` per node execution, rolled up into `workflow_runs.total_cost_usd`.
    - Agent config lives **inline** on the node (`model`, `system_prompt`, `output_schema`, `input_fields`, ...) — a deliberate temporary denormalization until the Agents module exists.
    - BYOK seam (`get_llm_client(api_key_override)`) is already in place, not yet wired to per-org keys.
11. **Tool Node Execution (`apps/api/src/graphs/node_handlers.py`):**
    - Two of Volume 2 §7.2's four tool types are real: **`http_request`** (outbound call via `httpx`, config-driven method/URL/headers/body, same retry-and-backoff shape as the LLM client) and a mock **`erp_connector`** (makes no network call; simulates posting a journal entry and returns a `MOCK-<uuid>` confirmation, so ERP workflow shapes from Volume 5 can be proven end-to-end before a real adapter exists). `python_function` and `mcp` are rejected by name rather than silently accepted.
    - Values reach a request through `body_fields` / `payload_fields` — `{destination_key: "dotted.state.path"}` maps resolved by the same safe path evaluator as the condition DSL. **No templating engine, no `eval()`.**
    - **Response status is classified three ways, deliberately:** `401`/`403` raise immediately (a credential failure returned as data would be indistinguishable from a business "not found" and would silently route the graph down the wrong branch); other `4xx` are returned as node output so graphs can route on them; `429` and `5xx` are retried, then raised.
    - **Credential containment:** a tool node's recorded output carries `status_code` and `body` only — request and response headers are never echoed into `node_executions.output`, and URLs are query-stripped before reaching any log line or error message. Both are pinned by tests.
    - Tool nodes leave `tokens_*` / `cost_usd` NULL — they have no LLM cost.
12. **Mutating-Tool Approval Guardrail (Volume 4 §4.3):**
    - A workflow **cannot be published** if any node marked `is_mutating: true` in its config has no `human_approval` node anywhere in its upstream dependency path. Returns 422 naming the offending `node_key`s.
    - Enforced at **publish time only** — an author can still save a half-built draft while wiring the approval gate.
    - Uses **"at least one"** semantics: a mutating node passes if any approval node exists among its ancestors, even where an individual branch reaches it unapproved. This matches the blueprint's wording and keeps its own reference workflows (Volume 5 §1 and §5, which both route straight to the journal-entry write on their clean branch) publishable.
    - **Known limitation, stated plainly:** `is_mutating` lives in free-form JSONB config, so a misspelled key silently skips the gate. A non-boolean value is rejected at node-invoke time, which catches `"true"` but not `is_mutation`.
13. **BYOK Credential Storage (`apps/api/src/modules/integrations/`, Volume 2 §13):**
    - Organizations can store their own OpenAI API key: `PUT` / `GET` / `DELETE /api/v1/integrations/{integration_type}`.
    - Encrypted at rest with **AES-256-GCM** under `INTEGRATION_ENCRYPTION_KEY` — a secret deliberately separate from `SECRET_KEY` and `JWT_SECRET_KEY`, so rotating a signing key never silently invalidates stored credentials.
    - **There is no code path that returns a stored key over HTTP**, even to the owning org. The status response exposes `last_four` and nothing else.
    - `integration:read` / `integration:write` are **Owner-only** — not granted to Admin — on the same reasoning as the billing permissions: a stored key is a direct billing-exposure lever.
    - Wired into execution: the org's key is resolved once per run and bound into the LLM client factory, falling back to the platform key when unset.
14. **Draft/Publish Validation Split:**
    - `save_draft` runs only the two rules that would corrupt storage (duplicate `node_key`, edges pointing at a missing key). Start/end presence, orphans, and cycles are **publish-time only**.
    - This is required, not lax: the canvas autosaves after every node drop, and every half-built graph violates at least one shape rule. The compiler is unaffected — it only ever compiles versions that have been published.
15. **Visual Builder Canvas (`apps/web/app/(dashboard)/workflows/[workflowId]/builder/`, Volume 3 §4):**
    - React Flow (`@xyflow/react`) canvas built by hand on shadcn/ui: drag-and-drop from a node palette, edge connection, per-type config forms, inline validation, 800 ms debounced autosave, and publish.
    - All seven node types share one card component driven by a data-only catalog (`lib/node-catalog.ts`) — no per-type component forks.
    - The graph lives in the React Query cache, not Zustand — `staleTime: Infinity` and `refetchOnWindowFocus: false` are load-bearing, since a background refetch would overwrite the canvas mid-edit.
    - `lib/graph-validation.ts` mirrors all seven backend rules in TypeScript for instant feedback. The server's 422 stays the authority; the vitest suite exists specifically to catch drift between the two implementations.
16. **Execution Viewer (`apps/web/app/(dashboard)/executions/`, Volume 3 §6):**
    - **List view** — every run in the org, newest first, cursor-paginated, filterable by workflow and status, with duration and cost per row.
    - **Timeline view** — node-by-node down the left using the *same* icon taxonomy as the builder canvas, with the selected node's input, output, timing, tokens, and cost on the right. Nodes that haven't run yet are shown too, resolved from the run's published version (a `node_execution` row only exists once a node actually runs).
    - **Sticky approval bar** when a run is `waiting_approval`, rendering the interrupt payload's upstream node outputs as the evidence to decide on, with Approve / Reject wired to the resume endpoint. No optimistic update — the UI waits for server confirmation.
    - **Live status by polling** (~2.5 s on the detail page, 10 s on the list and only while something is still in flight), stopping automatically once a run reaches a terminal state. Real WebSocket streaming (Volume 2 §9.2) is a deliberate future upgrade — the Redis Pub/Sub fan-out it needs does not exist yet.
    - New backend endpoint `GET /api/v1/executions` (org-scoped, cursor-paginated, `execution:read`) added to serve it.
17. **Three latent Celery-worker bugs found and fixed** while proving that loop end-to-end. The worker had **never successfully executed a task from the broker**, and the test suite could not have caught it — tests drive the graph directly and bypass Celery entirely:
    - The Celery app declared no `include`, so its task registry was empty and every job was discarded as "unregistered task".
    - Once tasks registered, SQLAlchemy mapper configuration failed: the worker imports only some model modules, and the rest are relationship targets. Fixed with a single `src/db/all_models.py` registration module.
    - Each task ran its own `asyncio.run()` against a module-level connection pool, so asyncpg connections outlived the event loop that created them and the *second* task in any worker process always died. Fixed by disposing the engine inside each task's loop.

---

## 🛠️ Local Setup Instructions

Want to spin this up on your local machine? You'll need Docker, [Poetry](https://python-poetry.org/) **2.x** (the lock file is `lock-version 2.1`, which Poetry 1.x cannot read), and Node 22.

### 1. Start the Infrastructure
Postgres **and Redis are both required** — Redis backs the permission cache, the rate limiter, and the Celery broker.
```bash
cd infra
docker compose up -d postgres redis
```

### 2. Configure Environment
Create `apps/api/.env`. Three variables are **required and have no defaults** — the app refuses to start without them:

```dotenv
SECRET_KEY=<any long random string>
JWT_SECRET_KEY=<any long random string>
# Must base64-decode to exactly 32 bytes (AES-256-GCM):
#   python -c "import os,base64; print(base64.b64encode(os.urandom(32)).decode())"
INTEGRATION_ENCRYPTION_KEY=<base64 32-byte key>

DATABASE_URL=postgresql+asyncpg://aap_user:aap_pass@localhost:5432/aap_db
REDIS_URL=redis://localhost:6379/0
CELERY_BROKER_URL=redis://localhost:6379/1

# Optional — agent nodes need a key from here or from an org's BYOK integration.
OPENAI_API_KEY=
```

### 3. Install Dependencies & Migrate
```bash
cd apps/api
poetry install
poetry run alembic upgrade head
poetry run python src/db/seed_roles.py   # seeds the 5 system RBAC roles
```

### 4. Run the Stack
Three processes. **The Celery worker is not optional** — without it a triggered run is created and then sits at `pending` forever, which looks like a frontend bug but isn't.

```bash
# terminal 1 — API
cd apps/api && poetry run uvicorn src.main:app --reload --port 8000

# terminal 2 — worker (use --pool=solo on Windows)
cd apps/api && poetry run celery -A src.workers.celery_app worker --loglevel=info -Q workflow_execution

# terminal 3 — frontend
cd apps/web && npm install && npm run dev
```

Then open <http://localhost:3000>, register an account, and build a workflow.

### 5. Run Tests
```bash
cd apps/api && poetry run pytest            # 188 backend tests
cd apps/web && npm test                     # 65 frontend tests (pure lib/ modules)
```

CI runs the same commands plus `ruff check`, `ruff format --check`, `eslint`, `tsc --noEmit`, and `next build` — see `.github/workflows/ci.yml`.

### 6. Explore the Database
Connect with your favourite client (DBeaver, pgAdmin, VS Code SQLTools):
- **Host:** `localhost` · **Port:** `5432`
- **User:** `aap_user` · **Password:** `aap_pass` · **Database:** `aap_db`

---

*This repository is actively being built. The core loop now works end-to-end through the UI: draw a workflow on the canvas, publish it, trigger a run, watch the timeline fill in node by node, approve the human-in-the-loop step, and see it complete — with tokens, cost, and a per-node audit trail persisted throughout. Next phases: the `subgraph` handler and a real `tools` module on the backend, the dashboard home and a Settings page for BYOK keys on the frontend, and WebSocket streaming to replace the Execution Viewer's polling.*
