# AI Automation Platform (AAP)

**Status**: Active Development  
**Current Phase**: Phase 2 — Workflow Engine (Graph Storage + LangGraph Compiler)

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

We have completed the foundational **Database Schema and Migration Layer** (Volume 2 §1 - §3.8), the **Authentication & RBAC Layer** (Volume 2 §10 - §11), the **Workflow Engine data layer** (Volume 2 §3.2), and the **Graph Compiler** (Volume 2 §6.1).

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
   - Real handlers: `start`, `end`, `human_approval` (uses LangGraph `interrupt()` — resume wiring is next phase).
   - Stub handlers: `agent`, `tool`, `subgraph` raise `NodeNotImplementedError` if invoked.
   - Process-local compiled graph cache with Redis invalidation markers; invalidated on draft replace via `save_draft`.
   - Synchronous in-process test runner with LangGraph `MemorySaver` (not production PostgresSaver).
   - **Not yet built:** Celery execution, `workflow_runs` writes, PostgresSaver checkpointing, resume API.

---

## 🛠️ Local Setup Instructions

Want to spin this up on your local machine? Ensure you have Docker and Poetry (or Pipx) installed.

### 1. Start the Infrastructure
We use Docker to run the database, cache, and object storage.
```bash
cd infra
docker compose up -d postgres
```

### 2. Install Dependencies
We use `pyproject.toml` to manage our dependencies. If you have [Poetry](https://python-poetry.org/) installed:
```bash
cd apps/api
poetry install
```

*(Alternatively, if you don't have Poetry, you can install the dependencies via pip manually):*
```bash
cd apps/api
python -m pip install alembic sqlalchemy asyncpg psycopg2-binary pgvector pydantic-settings pydantic
```

### 3. Run Database Migrations
Push the database schemas, indexes, and RLS policies into the live Postgres container:
```bash
cd apps/api
alembic upgrade head
```

### 4. Run Tests
```bash
cd apps/api
poetry run pytest
```

### 5. Explore the Database
Connect to the database using your favorite client (DBeaver, pgAdmin, VS Code SQLTools) with the following credentials:
- **Host:** `localhost`
- **Port:** `5432`
- **User:** `aap_user`
- **Password:** `aap_pass`
- **Database:** `aap_db`

---

*This repository is actively being built. Next phases: LangGraph runtime + Celery + PostgresSaver checkpointing, and the visual builder frontend.*
