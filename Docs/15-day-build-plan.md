# 15-Day Build Plan — from workflow engine to demo-able RAG product

**Written:** 2026-08-14 · **Window:** 2026-08-14 → 2026-08-29
**Budget:** $8.00 of OpenAI credit · **Projected spend:** $3–4
**Rendered version:** https://claude.ai/code/artifact/1c108878-d26a-4d36-87b1-66130fdd41b2

> This is the working plan for the next fifteen days. It is the source of truth;
> the link above is the same content as a formatted page. **If the plan changes,
> change it here** — the artifact is a view, this file is the record.
>
> Goal: the platform becomes something that can be demoed cold to an interviewer
> or an Upwork client. The single missing capability is grounding an agent in the
> user's own documents.

---

## 1. Where the platform actually stands

Read from the code on 2026-08-14, not from the status section of CLAUDE.md.

### Built and proven

Auth/RBAC/multi-tenancy · workflow builder canvas · Celery + LangGraph execution
engine with Postgres checkpointing · human-approval interrupt and resume ·
publish-time mutating-action guardrail · agent nodes with structured outputs and
real cost tracking · tool registry with `tool_executions` audit · manual, cron
and HMAC-webhook triggers · immutable audit log · per-org daily run quota · BYOK
OpenAI keys · execution viewer · marketing landing page.

**389 backend tests, 243 frontend tests.**

### Provisioned but unused — the head start

This is the part that is easy to miss, and it is why one module of work gets us
to RAG rather than a whole subsystem:

| Thing | State |
|---|---|
| MinIO object storage | **Client landed 2026-08-15** — `src/core/storage.py`, the first code to touch it |
| `document_chunks` HNSW index | Shipped, and **populated 2026-08-15**. Queried on day 1; retrieval service is days 6–7 |
| `document_chunks` GIN index | Also shipped — `to_tsvector('english', content)`. **Hybrid search is pre-indexed**, only unqueried |
| `worker_documents` Celery queue | **Live 2026-08-15** — runs `ingest_document` |
| `LLMClient.embed()` | **Proven 2026-08-15**, and now driving ingestion |
| KB tables | `knowledge_bases`, `documents`, `ocr_results`, `document_chunks` all exist |

### Missing

- ~~`knowledge_base` module is models-only~~ — **built 2026-08-15** (days 2–5).
- ~~No extraction, chunking or embedding pipeline~~ — **built 2026-08-15**.
  **Retrieval is still missing** and is days 6–7: nothing queries the vectors yet.
- No KB UI.
- Audit-log viewer UI (endpoint complete since 2026-08-09, zero consumers).

### Deliberately not built — leave alone

`subgraph` handler (stub) · agent function-calling / ReAct (deferred, see below)
· `python_function` and `mcp` tool types (rejected by name) · WebSocket live
updates (polling instead) · OCR.

---

## 2. Product surface — how to describe it

Phrase capabilities the way a buyer recognises them, not as modules:

- **Visual workflow builder** — agents, tools, conditions and approval gates on a canvas.
- **Document-grounded agents** *(to build)* — answers and decisions from the customer's own policies and contracts, with citations.
- **Human approval gates** — a run pauses, a person reviews, only then is anything written.
- **The mutating-action guardrail** — the differentiator. A node that writes to a real system is *blocked at publish time* unless a human approval sits upstream. A rejection, not a convention.
- **Connect to any HTTP system** — reviewed endpoints in a registry; a workflow supplies the payload but can never re-point a reviewed tool.
- **Triggers** — manual, cron in the org's timezone, signed webhooks.
- **Full run forensics** — node timeline, inputs/outputs, tokens, per-run USD. Secrets stripped from every snapshot.
- **Cost governance** — per-run cost and a per-org daily cap enforced before enqueue. BYOK, encrypted at rest.
- **Tamper-evident audit log** — append-only, enforced by a Postgres trigger rather than by application code.

---

## 3. Use cases

### Flagship — invoice approval with policy-grounded checks

```
webhook → extract → knowledge_search → validate → condition → human_approval → post to ERP
```

An invoice arrives by webhook. An agent extracts its fields, retrieves the vendor
contract and AP policy from the knowledge base, and checks the invoice against
the purchase order and agreed terms. Anything over threshold or outside policy
stops at a person. Only after approval does it post to the ledger.

**Why this one:** it exercises every subsystem — triggers, structured outputs,
RAG, tool registry, conditional routing, approval gate, mutating guardrail, cost
tracking, audit trail. It is also *already the story the landing page tells*
(`PO-4471 → GR-2214 → INV-2291 → JE-99120`, Acme Vendor LLC, $4,200), so the
marketing site and the product agree with no extra work.

### Secondary — expense claim policy review

Agent reads a claim, retrieves the expense policy, flags violations with a
citation to the clause. Clean claims auto-approve; exceptions route to a human.
Shows RAG changing an **outcome**, not just producing text.

### Tertiary — HR policy assistant

Grounded Q&A over an employee handbook. Cheapest to run, easiest to demo cold —
good as the opening 30 seconds before the invoice flow.

---

## 4. Architecture decisions — settled before day one

### Retrieval ships as a TOOL TYPE, not a new node type

Adding a `retrieval` entry to `NodeType` touches the backend enum, `node_handlers.py`,
the frontend `node-catalog.ts`, a config form, **and** `lib/graph-validation.ts`,
which duplicates the backend rules in a second language. Adding `knowledge_search`
alongside `http_request` in the existing tool dispatcher touches one function,
inherits the registry picker UI already built, and gets `tool_executions` audit
logging for free.

### Retrieve → generate, NOT an agent loop

A retrieval tool node feeding an agent node is classic RAG and needs nothing new.
The agentic alternative needs function-calling, which is deliberately deferred —
and `apps/api/CLAUDE.md` records why: **tool calls emitted by an agent have no
node in the graph, so `validate_mutating_approval` structurally cannot see them.**
That is an open security question needing a runtime refusal, not a missing
feature. Do not open it mid-sprint.

### Skip OCR entirely

The `ocr_results` table exists and will invite you to fill it. Scanned-document
OCR needs Tesseract or a vision model and is a multi-day detour that adds nothing
a demo shows. Accept text-extractable PDF, DOCX and Markdown; leave the table
unused and say so in the README.

### Approval copy is a FRONTEND concern

Render "Approve $4,200.00 to Acme Vendor LLC?" derived in the frontend from
upstream node outputs. **Do not add a message field to `human_approval`** — the
backend contract deliberately has none (`apps/web/CLAUDE.md` says so explicitly),
and this is presentation, not schema.

---

## 5. The fifteen days

Ordered by risk, not by comfort.

### Day 1 — prove the key, cap the money · ~$0.05

- [ ] **Set a hard usage limit in the OpenAI dashboard** before the key touches
      any code. The only control that cannot be defeated by a bug in our own software.
      *(Owner-side, not verifiable from here — confirm it before day 10, where
      the spend actually starts.)* App-side caps ARE in:
      `DAILY_RUN_QUOTA_PER_ORG=50` in `infra/.env`.
- [ ] Re-verify `_MODEL_PRICING` and `_EMBEDDING_MODELS` in `src/core/llm_client.py`
      against the live pricing page. Both are hand-maintained and carry an
      explicit staleness warning. *(Partial: internal consistency proven — a live
      `parse()` produced `cost_usd` matching the table exactly — and the rates
      agree with §6. The live pricing page itself is still unchecked.)*
- [x] Store the key; run an agent workflow end to end; confirm tokens and
      `cost_usd` persist. Key lives in `infra/.env` (gitignored) rather than
      BYOK, because probes and seed scripts call `get_llm_client()` with **no
      organization to resolve a BYOK key against**. BYOK still works and is the
      better path for app runs; `.env` is the documented fallback for scripts.
- [x] **Call `embed()` for the first time.** 1536-d confirmed, unit-normalised,
      real vector in `document_chunks`, cosine ranking semantically correct.

> **Gate:** a real vector in a real row. If `embed()` misbehaves, every later
> phase changes — better known on day one than day six.
>
> **PASSED 2026-08-15.** See the progress log in §8 for what else day 1 turned
> up — three latent bugs, one of which meant the stack could never boot on a
> fresh volume.

### Days 2–5 — ingestion pipeline · ~$0.15

- [x] Storage service over MinIO via `boto3` — `src/core/storage.py`. Keys are
      `org/kb/document-id/file`; the document id is inserted so two uploads of
      `policy.pdf` into one KB cannot overwrite each other's bytes.
- [x] Deps added: `pypdf` (pure Python — no apt packages in `python:3.12-slim`),
      `python-docx`, `tiktoken`.
- [x] `knowledge_base` built to the five-file convention. `embedding_model`
      validated against `SUPPORTED_EMBEDDING_MODELS`; API default is **-small**
      (the column default is -large, deliberately different — see the module docs).
- [x] Ingestion task on `worker_documents` — the first task ever registered on
      that container. `uploaded → processing → indexed | failed`, with
      `documents.error` added so a failure says why.
- [x] **Content hash; unchanged files skip embedding.** Done at *upload*, not
      just re-ingest: a re-upload creates a new row, which is the case that
      actually costs money. Returns HTTP 200 with the existing document.
- [x] Cross-tenant isolation tests, including chunks —
      `test_chunks_are_isolated_between_orgs`.

> **Gate PASSED 2026-08-15.** `curl -F file=@ap-policy.pdf` → 202 → worker →
> `indexed` with `page_count`, 1536-d vectors in `document_chunks`, chunk text
> readable through the API. Re-upload returned 200 and spent nothing.

### Days 6–7 — retrieval and the search tool · ~$0.20

- [ ] Retrieval service: embed the query with the KB's **own** model (never a
      default — cross-model cosine returns plausible numbers and meaningless
      rankings), cosine search over HNSW, top-*k* with a score floor.
- [ ] *Optional:* keyword leg over the existing GIN index, fused with reciprocal
      rank. The index is already there; only the query is missing.
- [ ] Add `knowledge_search` to the tool dispatcher and the registry's accepted
      types. Return chunk text **plus** document name and chunk index so the
      agent can cite.
- [ ] Tests — including a query against an empty KB returning nothing rather than raising.

> **Gate:** a published workflow whose tool node returns real chunks into graph state.

### Days 8–9 — knowledge base UI · ~$0.30

- [ ] `/knowledge` page: create KB, drag-drop upload, document list with live
      status, delete.
- [ ] Chunk inspector — open a document, read its chunks.
- [ ] **Retrieval playground** — type a question, see ranked chunks with scores.
      Highest-value screen for a demo; one embedding call per query.
- [ ] Wire `knowledge_search` into the builder's tool config form with a KB picker.
- [ ] Loading / empty / error states on every new surface (house rule, not polish).

### Days 10–12 — the flagship workflows · ~$1.50–2.50

- [ ] Write the demo corpus: AP policy, Acme Vendor LLC contract, expense policy,
      short employee handbook. Real prose, consistent with the numbers the
      landing page already uses.
- [ ] Seed script — demo org, workspace, KB, registry tools, published workflows,
      reproducible from empty.
- [ ] Build and tune the invoice workflow end to end. **Prompt iteration is where
      the budget actually goes** — stay on the cheap model until the logic is right.
- [ ] Build the expense and HR workflows on the same pieces.
- [ ] Approval sentence rendered in the frontend (see §4).

> **Gate:** trigger → retrieve → decide → approve → post, with citations, from a
> clean database.

### Days 13–14 — portfolio surface · ~$0.30

- [ ] Audit log viewer UI. Cheap page; demonstrates governance, which is what an
      enterprise buyer actually asks about.
- [ ] Fix the dangling `#how-it-works` anchor — the nav, the footer and the
      hero's "Watch a run" button all target an id that no longer exists.
- [ ] Check the landing page on a real phone. Never been seen on one, and the
      plate is a 1.51-aspect image a portrait viewport crops hard.
- [ ] README: architecture diagram, demo script, and an honest "deliberately not
      built" section — that last part reads as engineering judgement, not as a gap.
- [ ] Record a three-minute walkthrough. A video outlives any environment you
      have to keep alive.

### Day 15 — buffer

Reserved. Something above will overrun, most likely ingestion, where file-format
edge cases live. If nothing did: reconcile actual spend, then decide on deployment.

---

## 6. Budget model

Rates from `_MODEL_PRICING` / `_EMBEDDING_MODELS` in `src/core/llm_client.py`,
USD per million tokens. **Re-verify on day one** — hand-maintained, and the file
says so.

| Model | Input | Output | Cost / RAG call | Calls per $1 | Use for |
|---|---:|---:|---:|---:|---|
| `gpt-4.1-nano` | $0.10 | $0.40 | $0.00046 | ~2,170 | Smoke tests, plumbing |
| `gpt-4.1-mini` | $0.40 | $1.60 | $0.00184 | ~540 | **Default for all development** |
| `gpt-4.1` | $2.00 | $8.00 | $0.0092 | ~109 | Final quality comparison only |
| `text-embedding-3-small` | $0.02 | — | ~$0.0004/doc | — | Development corpus |
| `text-embedding-3-large` | $0.13 | — | ~$0.0026/doc | — | Final demo corpus |

A RAG call is costed at ~3,000 input tokens (five chunks + system prompt) and 400
output. A 40-page policy PDF is ~20,000 tokens to embed. Re-indexing a
50-document corpus ten times stays under fifty cents — **embeddings are not where
the money goes.** ~1,500 development runs on mini ≈ $2.80, a realistic upper
bound for fifteen days of prompt iteration.

### The real risk is a loop, not a price

Nothing above exhausts $8 at a working pace. A runaway can: a Celery retry storm,
or an accidental default to the expensive model inside a scheduled workflow. Four
cheap defences:

1. Hard cap in the OpenAI dashboard.
2. Low `DAILY_RUN_QUOTA_PER_ORG` in development.
3. Content-hash skip on re-ingestion.
4. **Never point a cron trigger at a workflow you are still tuning.**

---

## 7. Scope risk and the cut list

Fifteen days builds one backend module, a worker pipeline, a retrieval layer, two
frontend pages and three demo workflows. Achievable at this repo's recent pace,
but with no slack past day 15. **Decide the cut order now, while it is a choice.**

Cut in this order:

1. **Hybrid keyword search** — no demo consequence; the GIN index waits for later.
2. **The HR workflow** — two use cases still show breadth.
3. **Audit log viewer** — governance becomes a talking point instead of a screen.
4. **Deployment** — demo from local Docker plus the recorded video. A live URL is
   stronger for Upwork but is the easiest thing to add in week three.
5. **Chunk inspector** — the retrieval playground carries the same message.

**Do not cut:** the retrieval playground, the approval sentence, and the README's
"deliberately not built" section. Each is small and does disproportionate work in
front of an audience.

---

## 8. Progress log

Append as you go, so a future session can pick up mid-sprint.

| Date | Day | Done | Spend to date |
|---|---|---|---|
| 2026-08-15 | 1 | **Gate PASSED.** `embed()` called for the first time — 1536-d, unit-normalised, real vector into `document_chunks`, cosine over HNSW ranked the AP clause 0.51 vs 0.10 for an unrelated one, tenant scoping via `document → knowledge_base` holds. `parse()` proven too (separate code path; days 6–7 feed retrieval into an agent node): structured output correct and `cost_usd` matched `_MODEL_PRICING` to the last digit. Full HITL run end to end on `gpt-4.1-nano` — trigger → agent → **held 18.3s at the gate** → approve → completed, 148/21 tokens, $0.000023 persisted to a real `node_executions` row. | ~$0.00004 |

| 2026-08-15 | 2–5 | **Gate passed.** `knowledge_base` module (CRUD + upload + chunks), `core/storage.py` (first MinIO code), `core/document_text.py` (pypdf/docx extraction, paragraph-packed chunking), `workers/document_tasks.py` (first task ever on `worker_documents`), migration `20260815_kb_ingestion`. Upload-time dedup returns 200 and spends nothing. **389 tests** (337 + 52). Also: test suite now refuses to run outside a `*_test` database, after it destroyed the dev data on day 1. | ~$0.0001 |

### Day 1 notes — read before day 2

Four things were found that the plan did not anticipate. All fixed 2026-08-15.

- **The dev stack could never boot on a fresh volume.** `lifespan` seeds system
  roles but has never run migrations, so the api died with `UndefinedTableError:
  relation "roles" does not exist` on every first run. Root CLAUDE.md had claimed
  since 2026-08-08 that the container "migrates-and-seeds itself", which is why
  it survived a week. Fixed in the `api` service's `command:` — and it must be
  `python -m alembic`, not bare `alembic`, or `env.py`'s `from src.db.base import
  Base` fails on sys.path.
- **BYOK "encryption at rest" was encrypted with a key committed to the repo.**
  `INTEGRATION_ENCRYPTION_KEY` had a default baked into `docker-compose.yml`.
  Rotated into a gitignored `infra/.env`. Do this on any new machine *before*
  storing anything — rotating later invalidates BYOK credentials **and**
  `webhook_secret_encrypted`.
- **`started_at` was overwritten on every execution leg**, so a run held at an
  approval gate reported only the duration of the resume — 0.04s for an 18.3s
  run, and a weekend-long invoice would read as milliseconds. Fixed with a SQL
  COALESCE; pinned by `test_started_at_survives_a_resume`.
- **"Run now" sends an empty `trigger_payload`.** There is no UI to supply one,
  so a manual-trigger agent node must carry its content in the system prompt.
  Relevant to days 10–12: the invoice workflow wants the **webhook** trigger, not
  manual, or it has nothing to extract from.

**Still open from day 1:** re-verify `_MODEL_PRICING` / `_EMBEDDING_MODELS`
against OpenAI's live pricing page. Only internal consistency and agreement with
§6 above have been confirmed.

**Environment note:** all of the above ran on the *Windows* machine, not the Mac.
Docker, the full stack, MinIO round-trips and the 337-test suite all work there —
see the root CLAUDE.md testing note for how to run pytest without Poetry on PATH.
