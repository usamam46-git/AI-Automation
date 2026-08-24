# Orkest — AI workflow automation for the back office

A multi-tenant SaaS platform for building AI workflows on a canvas and running
them against real business systems: agents that read the company's own
documents, tools that call real endpoints, and **an approval gate that a human
has to clear before anything is written**.

It is a working system, not a prototype. Workflows compile to LangGraph state
machines, run on Celery workers with PostgreSQL checkpointing, pause mid-run for
a human decision, resume days later from the checkpoint, and record every token
and every cent they spent.

---

## See it run

An expense claim that breaches the policy three ways, triggered from the UI. The
agent reads it, retrieves the company's own expense policy, and the run **stops
at the approval gate** — quoting the clause it stopped on. A human approves, and
only then does the ERP write happen.

<p align="center">
  <img src="Docs/media/approval-gate.gif" alt="A workflow run pausing at a human approval gate, then completing after approval" width="100%">
</p>

Nothing above is staged: it is one real run against the local stack, and the
figures on screen — `$0.0011`, `4179 in / 320 out`, `1m 10s` — are what it
actually cost and took.

---

## The one idea worth reading about

**A node that writes to a real system cannot be published unless a human
approval sits upstream of it in the graph.** Not a lint warning, not a
convention in a style guide — a `422` from the publish endpoint, naming the
offending node.

```
POST /api/v1/workflows/{id}/versions/{v}/publish  →  422

  Node 'post_to_erp' performs a mutating action but has no
  human_approval node anywhere upstream of it.
```

Everything else here is table stakes for a workflow tool. This is the part that
answers the question an enterprise buyer actually asks, which is not "can your
agent do it" but "what stops your agent from doing it wrong". The gate is
structural: it is checked against the graph at publish time, so it holds for
every future run of that version, and a published version's nodes are immutable
afterwards.

Three limits of the guardrail are documented rather than glossed over, because
knowing where a safety net ends is the difference between a guarantee and a
vibe:

- It is **publish-time only**, so half-built drafts still save.
- It uses **∃-semantics** — a mutating node passes if *any* approval exists in
  its ancestor set, not if every path reaches one. (∀ would reject the reference
  workflows this platform was specified against.)
- It **fails open on a typo** for nodes carrying inline config, and **fails
  closed** for nodes referencing a registry tool, where `is_mutating` is a typed
  column that cannot be misspelled.

---

## Architecture

```mermaid
flowchart TB
    subgraph client["apps/web — Next.js 16 · React 19"]
        canvas["Builder canvas<br/>(React Flow)"]
        viewer["Execution viewer<br/>+ audit log"]
        kb["Knowledge base UI<br/>+ retrieval playground"]
    end

    subgraph api["apps/api — FastAPI"]
        direction TB
        router["router → service → repository"]
        compiler["Graph compiler<br/>src/graphs/"]
        guard["validate_mutating_approval()<br/>publish-time gate"]
    end

    subgraph workers["Celery workers"]
        wf["worker_workflow<br/>LangGraph execution"]
        docs["worker_documents<br/>extract → chunk → embed"]
        beat["beat<br/>schedule tick, 60s"]
    end

    subgraph data["Data"]
        pg[("PostgreSQL 16<br/>+ pgvector<br/>row-level security")]
        redis[("Redis<br/>broker · cache · quota")]
        minio[("MinIO<br/>source documents")]
    end

    openai["OpenAI<br/>completions + embeddings"]

    client -->|"JWT, org-scoped"| api
    router --> guard
    router --> compiler
    api -->|enqueue| redis
    redis --> workers
    beat -->|"polls next_run_at"| pg
    wf -->|"checkpoints every superstep"| pg
    wf --> openai
    docs --> minio
    docs --> openai
    docs -->|"1536-d vectors → HNSW"| pg
    api --> pg
    api --> redis
    api --> minio
```

### How a run actually flows

```mermaid
sequenceDiagram
    participant T as Trigger<br/>(manual · cron · signed webhook)
    participant A as API
    participant Q as Redis
    participant W as Worker
    participant P as Postgres
    participant H as Human

    T->>A: request
    A->>A: HMAC verify (webhook only)
    A->>Q: claim daily run quota → 429 if exhausted
    A->>P: INSERT workflow_run + audit row (one transaction)
    A->>Q: enqueue
    Q->>W: execute_workflow
    W->>P: load published version, compile to LangGraph
    W->>W: agent node → OpenAI structured output
    W->>W: knowledge_search tool → cosine over HNSW
    W->>P: checkpoint after every superstep
    W-->>P: human_approval → interrupt, task EXITS
    Note over W,P: the run now costs nothing<br/>and can wait indefinitely
    H->>A: approve / reject
    A->>P: audit the decision
    A->>Q: enqueue resume
    Q->>W: resume from checkpoint (leg 2)
    W->>W: mutating tool runs — only now
    W->>P: completed, with per-node tokens and USD
```

The interrupt is the load-bearing part. A paused run is not a worker holding a
thread — the Celery task exits, the graph state lives in the checkpoint table,
and a second task resumes it later. `_stream_graph` therefore runs **once per
leg, not once per run**, which is the mental model to hold before changing
anything in it.

---

## What is built

| Capability | State |
|---|---|
| Auth, RBAC, multi-tenancy | argon2, short-lived JWT, rotating refresh cookie, Postgres RLS as defence-in-depth |
| Members and roles | Five roles, signed invite links, suspend/remove, and a last-Owner rule that refuses to strand an org |
| Visual workflow builder | React Flow canvas, per-type config forms, inline validation, 800 ms debounced autosave |
| Execution engine | LangGraph compiled from the stored graph, Celery, PostgreSQL checkpointer |
| Human approval gates | Real interrupt/resume, approve or reject, derived approval sentence in the UI |
| Mutating-action guardrail | Enforced at publish (see above) |
| Agent nodes | OpenAI structured outputs, real token counts and per-node USD |
| Document-grounded retrieval | Upload → extract → chunk → embed → HNSW cosine search, with citations |
| Tool registry | Reviewed endpoints; a workflow supplies the payload but can never re-point a reviewed tool |
| Triggers | Manual, cron in the org's timezone, HMAC-SHA256 signed webhooks |
| Run forensics | Node timeline, inputs/outputs, tokens, per-run USD — secrets stripped from every snapshot |
| Cost governance | Per-run cost, per-org daily cap enforced before enqueue, BYOK keys encrypted with AES-256-GCM |
| Audit trail | Append-only, enforced by a Postgres trigger rather than by application code |

### The canvas

Workflows are built as a graph and stored as one. Each node type gets its own
config form — an agent node carries its system prompt, its input field paths and
a typed output schema; a `human_approval` node has nothing to configure, which
is the point.

<p align="center">
  <img src="Docs/media/builder-canvas.gif" alt="The workflow builder canvas, showing node configuration for an agent and a human approval node" width="100%">
</p>

### Retrieval, concretely

The retrieval playground exists to calibrate the score floor, so it deliberately
searches with no cutoff and draws the boundary visually instead of hiding what
would have been discarded. The query below returns the same clause the approval
gate quoted above.

<p align="center">
  <img src="Docs/media/knowledge-retrieval.gif" alt="Searching a knowledge base and reading the ranked passages returned" width="100%">
</p>

Ingestion is `pypdf`/`python-docx` extraction → paragraph-packed chunking →
`text-embedding-3-large` requested at **1536 dimensions** (Matryoshka
truncation, so -large's retrieval quality at -small's index cost) → pgvector
HNSW. Deduplication happens at *upload* on a content hash, so re-dropping a file
during development returns `200` and spends nothing.

Search ships as a **tool type**, not a node type — so it inherits the registry
picker, the per-usage override rules and the `tool_executions` audit trail that
already existed, instead of touching a backend enum, a frontend node catalog, a
config form and a second copy of the validation rules.

One detail that is easy to get wrong and expensive to get wrong: the query
orders by **raw cosine distance ascending**, never by `1 - distance` descending.
The two are algebraically identical and return the same rows in the same order —
and the second one silently stops matching the HNSW index and degrades to a
sequential scan over every chunk in the organization.

---

## Deliberately not built

This section is the honest one. Everything here was a decision, not an
oversight, and each has a reason written down next to the code.

- **OCR.** A scanned PDF raises `UnextractableDocumentError` instead of indexing
  zero chunks. A knowledge base that silently indexes to nothing answers "I
  don't know" forever with nothing explaining why — a loud failure is strictly
  better, and OCR is a whole subsystem for a demo corpus that is all digital.
- **Agent function-calling / ReAct loops.** The OpenAI `tools=` array is built
  and unit-tested; the loop is not. It needs a second LLM entry point,
  multi-call cost accumulation, and — the real blocker — a *runtime* refusal
  path, because tool calls an agent emits have no node in the graph, so the
  publish-time guardrail structurally cannot see them. Shipping the loop without
  that would quietly hollow out the product's main safety property.
- **Hybrid keyword search.** The GIN index (`to_tsvector('english', content)`)
  has shipped since the initial schema and is unqueried. Cut first on purpose:
  it has no demo consequence, and dense retrieval carries the use cases here.
- **WebSocket live updates.** Status is polled, and every poll stops the moment
  nothing on screen can still move. Real-time infrastructure for a status field
  that changes three times an hour is not a trade worth making yet.
- **`python_function` and `mcp` tool types.** Rejected by name at create time,
  not silently accepted as rows that only explode at run time.
- **`subgraph` node handler.** A stub that raises if invoked.
- **A real ERP adapter.** `erp_connector` is an explicit mock returning
  `MOCK-<uuid>` confirmations. It exists so the mutating-tool mechanism can be
  proven end to end before a vendor integration exists — the guardrail, the
  approval gate and the audit trail are all real; only the far end is not.

---

## Running it

### 1. Secrets, before anything else

```bash
cp infra/.env.example infra/.env
```

Then generate the three values it names. This step is first for a reason:
every secret in `infra/docker-compose.yml` is written `${VAR:-default}` and
**those defaults are committed to this repository**. The stack boots on a fresh
clone with no setup, which is exactly why it is easy to miss that
`INTEGRATION_ENCRYPTION_KEY` — the key encrypting BYOK API keys and webhook
signing secrets at rest — is public until you create that file.

Do it *before* storing any credential, not after. AES-GCM authenticates, so
rotating the key does not degrade old ciphertext, it destroys it.

### 2. Bring the stack up

```bash
cd infra && docker compose up -d --build
```

Eight services: Postgres 16 + pgvector, Redis, MinIO, the API, three Celery
workers and beat. The `api` service runs `alembic upgrade head` before
`uvicorn`, and seeds the system RBAC roles on startup.

```bash
curl -s localhost:8000/api/docs   # OpenAPI
```

### 3. The frontend

```bash
cd apps/web && npm install && npm run dev   # localhost:3000
```

### 4. Optional: the demo data

Seeds two knowledge bases, three registry tools and three published workflows
into an existing organization, resolved by the email you registered with.
Everything goes through the real services, so a graph that seeds is a graph that
publishes.

```bash
docker exec -w /app aap_api python -m src.db.demo.seed --email you@example.com
docker exec -w /app aap_api python -m src.db.demo.send_invoice
```

---

## Demo script — about three minutes

1. **Land on `/dashboard`.** Four stat cards over real runs. Note that the
   success rate excludes rejected runs: a rejection is the approval gate working
   correctly, and counting it as a failure would mean an organization's score
   falls the more carefully it reviews.
2. **Open the invoice workflow in the builder.** Eight nodes:
   `extract_invoice` → `policy_lookup` (a `knowledge_search` against the AP
   policy) → `validate_invoice` → `check_amount` → `approval_1` → `post_to_erp`.
   Delete the approval node and hit Publish → **422, naming `post_to_erp`.**
   Put it back.
3. **Fire the webhook** (`send_invoice.py`, HMAC-signed). The run appears in
   Executions and stops at the gate.
4. **Open the run.** The timeline shows the retrieved chunk that justified the
   coding, the agent's structured output, and the ERP node still `pending`. The
   approval prompt is *derived* from upstream node outputs — "Approve $4,200.00
   to Acme Vendor LLC?" — and never invents a figure it could not read.
5. **Approve.** Second leg runs, ERP write completes, total cost lands at about
   two tenths of a cent.
6. **Open the audit log.** The publish, the run, the approval and the actor's IP
   are all there. Then try `UPDATE audit_logs ...` in psql and watch Postgres
   refuse it — the immutability is in the database, not in the application.

---

## Testing

```bash
# Backend — must target a *_test database; the suite hard-exits otherwise.
docker exec aap_postgres psql -h 127.0.0.1 -U aap_user -d postgres -c "CREATE DATABASE aap_test;"
docker exec -w /app aap_api poetry install --no-root --with dev
docker cp apps/api/tests aap_api:/app/tests
docker exec -e PYTHONPATH=/app -w /app \
  -e DATABASE_URL=postgresql+asyncpg://aap_user:aap_pass@postgres:5432/aap_test \
  aap_api python -m pytest -q

# Frontend
cd apps/web && npm test
```

**467 backend tests · 363 frontend tests.**

Two conventions worth knowing:

- **Isolation is truncate-based, and the suite refuses to run outside a `*_test`
  database.** The guard exists because a run against the dev database once
  destroyed an org, a user, a published workflow and its entire run history —
  the only symptom being the next login failing with "system roles not seeded".
  The obvious wrap-each-test-in-a-transaction alternative was tried and does not
  work here; the two concrete reasons are recorded in `apps/api/CLAUDE.md`.
- **The suite needs nothing but Postgres and Redis.** Object storage is stubbed
  with an in-memory store of the same shape, so an upload followed by an
  ingestion still round-trips the real bytes. To prove a change has not
  reintroduced a dependency, run with `MINIO_ENDPOINT` pointed at an unroutable
  address rather than trusting a green run on a dev machine.

Frontend tests cover the pure `lib/` modules only. Canvas interaction, 3D
scene composition and theming are manual-verification by design — with one
exception: the landing page's scroll choreography lives in a pure module with
real camera-projection maths, so its composition is asserted rather than
eyeballed.

---

## Repository layout

```
apps/api/          FastAPI backend
  src/modules/     domain modules — models · schemas · repository · service · router
  src/graphs/      LangGraph compiler, node handlers, safe condition evaluator
  src/workers/     Celery app, execution tasks, ingestion, schedule tick, checkpointer
  src/core/        LLM client, encryption, storage, cache, permissions
  src/db/demo/     demo corpus, workflow graphs, idempotent seed
  tests/           flat test_<domain>.py files
apps/web/          Next.js frontend (App Router)
  app/(marketing)/ public landing page
  app/(dashboard)/ the product
  lib/             pure, vitest-covered modules
infra/             docker-compose, .env.example
Docs/              the seven-volume engineering blueprint this is built against
```

Two structural rules the code follows without exception: **routers contain no
business logic** (route decorator, dependency injection, one call to the
service), and **`organization_id` always comes from the authenticated context** —
never from a request body, a path parameter or a query string. Any schema with a
client-settable `organization_id` is a bug.

---

## Stack

**Backend** — Python 3.12, FastAPI, SQLAlchemy 2 (async), Alembic, PostgreSQL 16
with pgvector, Redis, Celery, LangGraph, OpenAI, MinIO, argon2, AES-256-GCM.

**Frontend** — Next.js 16, React 19, TypeScript, Tailwind, shadcn/ui on Radix,
TanStack Query, Zustand, React Flow, GSAP, three.js / React Three Fiber.
