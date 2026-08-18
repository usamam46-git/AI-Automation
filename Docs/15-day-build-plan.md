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
- [x] Re-verify `_MODEL_PRICING` and `_EMBEDDING_MODELS` in `src/core/llm_client.py`
      against the live pricing page. Both are hand-maintained and carry an
      explicit staleness warning. **Closed 2026-08-16: all 11 rates match the
      live page exactly** (gpt-4.1 2.00/0.50/8.00, -mini 0.40/0.10/1.60, -nano
      0.10/0.025/0.40, embedding-3-small 0.02, -large 0.13), and §6's table
      agrees. Note the page moved: `platform.openai.com/docs/pricing` now 301s to
      `developers.openai.com/api/docs/pricing`.
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

- [x] Retrieval service: embed the query with the KB's **own** model (never a
      default — cross-model cosine returns plausible numbers and meaningless
      rankings), cosine search over HNSW, top-*k* with a score floor.
      `build_chunk_search_stmt` in `knowledge_base/repository.py` is shared by an
      async path (the API) and a sync one (the tool node), because those two
      callers have irreconcilable session types and duplicating the query is how
      the sync copy quietly loses its tenant filter.
- [ ] *Optional:* keyword leg over the existing GIN index, fused with reciprocal
      rank. **Deliberately deferred** (it is cut #1 in §7, and the index waits).
- [x] Add `knowledge_search` to the tool dispatcher and the registry's accepted
      types. Return chunk text **plus** document name and chunk index so the
      agent can cite.
- [x] Tests — including a query against an empty KB returning nothing rather than raising.
      **408 backend tests** (389 + 19).

> **Gate PASSED 2026-08-16.** Live, against the real stack, in the org holding
> the BYOK key: AP policy ingested through `worker_documents` → `indexed`,
> 1536-d. Published `start → knowledge_search → agent → end`, triggered through
> the real Celery worker → `completed`. The tool node returned a real chunk at
> **cosine 0.5589** into graph state, and the agent answered from it and cited
> `ap-policy.txt`. Run cost $0.000051.
>
> Three decisions settled during the build, none of them in the plan beforehand:
> **cost is attributed** to `knowledge_search` (it emits `node_usage`, breaking
> the old "tool nodes never report usage" invariant, which described the two
> tools that existed rather than a principle); **`knowledge_base_id` is
> registry-owned, not node-overridable** (it is the analogue of `url` — only
> `query`/`query_fields` joined `NODE_OVERRIDABLE_KEYS`); and
> **`is_mutating: true` is rejected on retrieval**, since a read that demands an
> approval gate upstream devalues the gate.
>
> One measured limitation: `cost_usd` is `Numeric(12,6)`, and a query embedding
> costs ~$0.0000002, so the **per-node** cost column rounds to 0.000000. The
> tokens are recorded (10/0) and the run total is right — `current_cost_usd`
> accumulates as a float before it is stored — so nothing is lost in aggregate.
> Widening the column is not worth a migration at this scale; revisit if
> retrieval volume ever makes per-node retrieval cost a figure anyone reads.

### Days 8–9 — knowledge base UI · ~$0.30

- [ ] `/knowledge` page: create KB, drag-drop upload, document list with live
      status, delete.
- [ ] Chunk inspector — open a document, read its chunks.
- [ ] **Retrieval playground** — type a question, see ranked chunks with scores.
      Highest-value screen for a demo; one embedding call per query.
- [ ] Wire `knowledge_search` into the builder's tool config form with a KB picker.
- [ ] Loading / empty / error states on every new surface (house rule, not polish).

### Days 10–12 — the flagship workflows · ~$1.50–2.50

- [x] Write the demo corpus: AP policy, Acme Vendor LLC contract, expense policy,
      short employee handbook. Real prose, consistent with the numbers the
      landing page already uses. **Markdown, not PDF** — `document_text.py` takes
      `.md` natively, so there is no generation step and the corpus is
      diff-reviewable. Lives in `apps/api/src/db/demo/corpus/`, under `src/`
      because that is the only path the `api` container bind-mounts: a wording
      change is live without an image rebuild.
- [x] Seed script — `python -m src.db.demo.seed --email you@example.com`. Seeds
      into an **existing** org rather than minting a demo one (see the day 10–12
      notes). Idempotent: KBs/tools/workflows are looked up by name, uploads
      dedup on content hash, and a workflow whose published graph already matches
      is skipped, so version numbers do not climb on re-runs.
- [x] Build and tune the invoice workflow end to end. One tuning round: retrieval
      `top_k` 5 → 8 on `finance_policy_search`. Total spend across every run in
      this phase was **under 2 cents**; the budget model over-estimated because a
      graph that works needs far fewer iterations than one being designed.
- [x] Build the expense and HR workflows on the same pieces.
- [x] Approval sentence rendered in the frontend (see §4) —
      `apps/web/lib/approval-summary.ts`, derived from upstream node outputs,
      falling back to the old generic headline when nothing can be derived.
- [x] **Not on the original list:** a trigger-payload box on Run now
      (`run-workflow-dialog.tsx`). Day 1's notes recorded that "Run now" sends an
      empty payload with no UI to supply one; that made two of the three demo
      workflows unrunnable from a browser, so it was in scope whether the plan
      said so or not.

> **Gate: PASSED 2026-08-17.** Signed webhook → extract → retrieve → validate →
> condition → **held at the gate** → approve → mock ERP write → `completed`.
> `$0.002233` for the run, citations to `ap-policy.md` §2 and the Acme MSA §2,
> and `account_code: "5100"` read out of the policy's own coding table. The
> guardrail was proven by removing `approval_1` from the same graph: 422 naming
> `post_to_erp`.

### Days 13–14 — portfolio surface · ~$0.30

- [x] Audit log viewer UI. Cheap page; demonstrates governance, which is what an
      enterprise buyer actually asks about. **Done 2026-08-18** — `/audit-log`,
      plus a small backend addition (`actor_email`) so the screen names people
      rather than UUIDs.
- [x] Fix the dangling `#how-it-works` anchor — the nav, the footer and the
      hero's "Watch a run" button all target an id that no longer exists.
      **Done 2026-08-18** — it is a scroll POSITION, not an element, so the
      anchor is placed by arithmetic off `SCENES`; see the day 13–14 notes.
- [x] Check the landing page on a real phone. Never been seen on one, and the
      plate is a 1.51-aspect image a portrait viewport crops hard.
      **Layout done 2026-08-19** — reported broken on an iPhone 15 Pro, root-caused
      to one grid item that could not shrink (the document went 494px wide on a
      393px screen, shifting every centred section). Fixed and verified at a true
      393×852. The 3D scene's *appearance* is still unverified and cannot be
      checked under automation — `ResizeObserver` never fires there, so R3F's
      canvas stays 300×150 and nothing renders. Needs eyes on a device.
- [x] README: architecture diagram, demo script, and an honest "deliberately not
      built" section — that last part reads as engineering judgement, not as a gap.
      **Done 2026-08-18** — the root README was still `create-next-app`
      boilerplate; it is now the portfolio front page, with two Mermaid diagrams.
- [ ] Record a three-minute walkthrough. A video outlives any environment you
      have to keep alive. **Still open — needs a screen recording.**

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

| 2026-08-16 | 6–7 | **Gate passed.** `knowledge_search` ships as a TOOL TYPE (not a node type, per §4): `build_chunk_search_stmt` shared by an async API path and a sync tool-node path, `POST /knowledge-bases/{id}/search` built early so days 8–9 are pure frontend, `NODE_OVERRIDABLE_KEYS` extended with `query`/`query_fields` only. Proven live end to end — retrieved chunk at cosine 0.5589 into graph state, agent answered from it and cited the document, run cost $0.000051. Hybrid keyword search deferred (cut #1). **408 tests** (389 + 19). Also closed day 1's last open item (live pricing re-verified, all 11 rates match) and rotated `INTEGRATION_ENCRYPTION_KEY` off the repo-committed default on the Mac. | ~$0.0002 |

| 2026-08-16 | 8–9 | **Gate passed, in a real browser.** `/knowledge` (list, create, rename, delete), KB detail with drag-drop upload, polled document status, chunk inspector and the retrieval playground; `knowledge_search` wired into the builder's tool form with a KB picker — **both** inline and registry, the latter closed by adding the type to `tool-dialog.tsx`, where it had been uncreatable. Verified in both themes: upload → `Queued` → `Indexed` by polling, re-drop reported "already indexed, nothing charged", playground ranked the passage at 39% and an unrelated question at 2% marked below cutoff, document delete cascaded its chunk. Then a registry-backed `start → knowledge_search → end` was published and **run through the real worker to `completed`**, node override of the question winning over the registry default, `tool_executions` row linked. Three real bugs found and fixed — see the day 8–9 notes below. **408 backend / 260 frontend tests.** | ~$0.0002 |

| 2026-08-18 | — | **Members + invitations — UNPLANNED, added on request.** Vol. 3 §10, which this plan never scheduled. Found while answering "where do we assign roles?": nowhere. `org_memberships` had exactly one writer in the codebase, so every user was the sole Owner of their own org and three of the five seeded roles had never been held by a real user. `organizations` went models-only → real (9 endpoints), migration `20260818_org_members`, signed invite links shown in the UI because there is no mail delivery, and a `register(invite_token=…)` branch so a brand-new invitee joins the inviting org rather than a throwaway one. **463 backend** (+31) and **346 frontend** (+21) tests. Verified live end to end, including the addressee guard refusing a wrong-account accept. Day 15's buffer is now partly spent. | ~$0.00 |

| 2026-08-18 | 13–14 | **Three of five done; two need hardware.** `/audit-log` — the endpoint had been complete and unconsumed since 2026-08-09, the same shape the integrations endpoints were in before the Settings page. Backend gained one field, `actor_email`, from a LEFT JOIN guarded on `actor_type = 'user'` (the column is polymorphic), because a governance screen rendering raw UUIDs undersells the feature. Page is 403-aware (Owner/Admin only), expands each row to its verbatim `metadata`, and does **not** poll — an audit row cannot change, and a trail that reorders itself while an auditor reads it is worse than one they refresh. `#how-it-works` fixed by arithmetic rather than by moving an id: verified live landing at scrub progress 0.5200 against the run scene's own 0.52 start. README rewritten from `create-next-app` boilerplate. **432 backend tests** (+2) and **325 frontend tests** (+33). | ~$0.00 |

| 2026-08-17 | 10–12 | **Gate passed, live.** Demo corpus (4 Markdown documents, ~9,500 words), `src/db/demo/` seed + `send_invoice.py`, three published workflows, the derived approval sentence and a trigger-payload box on Run now. All three workflows proven end to end against the real worker: the invoice held at its gate and completed on approval with a correct ERP payload; the expense claim was routed to a human **by the retrieved policy** (`compliant: false`, receipt rule cited, `reimbursable_amount` 700.55 — the landing page's own figure); the HR assistant answered from the handbook in one leg, twice, once on its static query and once on a payload question. Guardrail re-proven on this exact graph (422 naming `post_to_erp`), forged webhook rejected with the uniform 401. **430 backend tests** (+19 pinning the demo graphs against the real validators) and **292 frontend tests** (+32). | ~$0.02 |

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

**Day 1 is now fully closed.** The pricing re-verification landed 2026-08-16 (see
the checkbox above). On the spend cap: the owner reports **$5 of prepaid credit
with auto-recharge disabled**, which is a harder ceiling than a usage limit —
the API returns `insufficient_quota` when the balance runs out, so it cannot be
defeated by a bug in our software, which is what the gate asked for. Budget is
$5 rather than the $8 this plan is written against; projected spend is $3–4, so
it fits with less slack for prompt iteration in days 10–12.

**The encryption-key trap recurred on the Mac (2026-08-16).** The day-1 fix was
made on the Windows machine and stored in `infra/.env` — a gitignored file,
which by construction cannot travel. So the Mac ran on the repo-committed
`INTEGRATION_ENCRYPTION_KEY` default and encrypted a real BYOK key under it.
Rotated the same day, and the warning moved to a **committed** `infra/.env.example`
so the next machine hits it before storing anything. Cost of rotating then: one
row. Do not let this slip past days 10–12, when demo workflows add webhook
secrets.

**Environment note:** all of the above ran on the *Windows* machine, not the Mac.
Docker, the full stack, MinIO round-trips and the 337-test suite all work there —
see the root CLAUDE.md testing note for how to run pytest without Poetry on PATH.

### Days 8–9 notes — three bugs the browser pass found

All three were invisible to the test suites, which is the argument for doing this
pass at all rather than trusting green CI.

- **No upload could ever have worked from the UI.** `apiClient` sets
  `Content-Type: application/json` on every request, and axios reads that header
  in `transformRequest` *before* it looks at the body — seeing JSON it runs the
  `FormData` through `formDataToJSON()`, so the file serialised to `{}` and the
  server answered 422 "Field required". Not a malformed multipart: a JSON body.
  Fixed by naming `multipart/form-data` at the call site, which only takes it off
  that path — axios strips the header again and the browser writes the real one
  with a boundary. `knowledgeApi.upload`'s docstring said the opposite ("Content-
  Type is deliberately not set"), which is right for `fetch` and wrong here.
- **The retrieval playground 500'd for any org on BYOK.** `KnowledgeBaseService.
  search()` called `get_llm_client` with no override, so it needed a server-wide
  `OPENAI_API_KEY` — while ingestion and the tool node both resolve the org's
  stored key through `_resolve_llm_client_factory`. The playground was the one
  retrieval surface that ignored BYOK, and this machine has no server key at all,
  so the highest-value screen in the module failed on its first query. Fixed in
  the service (not the router) so the injection seam the tests use survives.
- **The tools dialog could not create a `knowledge_search` row**, which made the
  builder's registry branch for that type unreachable code. Adding it exposed a
  fourth, smaller thing: with the extra fields the dialog outgrows a 776px window
  and `DialogContent` has no `max-height`, so Create sat off-screen with no way to
  scroll to it.

**Verification caveat worth knowing before the next browser pass:** synthetic
typing into a *node config* field collapses to one character per burst. The value
round-trips through the React Query cache, so the re-render lands a keystroke
late and React rewinds the DOM input to the stale value. At ~300ms per character
(human speed) it is correct, and it affects every builder config field equally —
the pre-existing `url` field included — so it is an automation artefact, not a
product bug. Type slowly, or assert on the DB row.

**Both gaps this pass opened were closed the same day:**

- **Deleting a knowledge base is now a 409 while anything still searches it** —
  the rule `ToolService.delete_tool` already applied to a tool a published
  version references, and it inherits that rule's asymmetry (published blocks,
  draft does not). Retrieval has two shapes of reference and both are checked:
  a live registry `knowledge_search` tool, reported **by name** because editing
  it is the fix, and a node carrying `knowledge_base_id` inline in a published
  version. The frontend renders the 409 in the dialog as a permanent explained
  state, not a toast — same treatment as the tools registry. Three integration
  tests, including one proving another org's identically-shaped tool is not a
  reference.
- **The workspace selection persists** (`zustand/middleware` `persist`,
  `localStorage`, key `orkest.workspace`). Two things keep it honest: the shell
  now **corrects** a stored id that is not in the fetched list rather than
  leaving it (a stale id would filter every list by something the API never
  matches, showing empty pages while the header named a workspace with content),
  and logout clears it so the next account does not start inside the previous
  one's workspace.

### Days 10–12 notes — what the demo actually taught

- **Two knowledge bases, not one.** `knowledge_base_id` is registry-owned on a
  `knowledge_search` tool specifically so a reviewed retrieval step cannot have
  its corpus swapped underneath it — and that guarantee is invisible when there
  is only one corpus to point at. Splitting Finance policies from the Employee
  handbook makes the constraint legible, and it keeps the HR assistant honest:
  it can only ever answer from the handbook.
- **The two mutating workflows route by different mechanisms, deliberately.**
  The invoice compares `total_amount` against the policy's USD 1,000 threshold
  with the structured condition DSL — deterministic, and the rule the landing
  page prints verbatim. The expense claim routes on an agent's `compliant`
  boolean, which is where the retrieved clause actually changes the outcome. A
  demo in which every decision is an LLM guess is not a governance story; one in
  which none are does not show RAG doing anything.
- **The sample expense claim has to breach the policy.** It routes on
  `compliant`, so a clean claim skips the gate entirely and the flagship feature
  never appears. A test asserts the payload still contains an unreceipted line
  above the USD 25.00 threshold, because "improving" the sample data would
  silently delete the human-in-the-loop step from the demo.
- **`top_k` 5 → 8 was worth one round.** At 5, the expense assessment found the
  receipt rule (§3) and missed the non-reimbursable list (§8), so it named one
  breach of three. At 8 it names two and the reimbursable total lands on
  **700.55** — the exact figure already on the landing page's expense card. Costs
  ~1,300 extra input tokens per call. This is the only tuning the whole phase
  needed.
- **A registry edit does not republish anything.** Re-running the seed after the
  `top_k` change updated the tool row and reported all three workflows already
  published — because the *graph* did not change, and the tool is resolved once
  per run. That is `resolve_node_configs` working, and it is a good thing to
  point at during a demo.
- **The seed goes through the services, not the repositories.** A graph that
  seeds is therefore a graph that publishes, and a tool config that seeds is one
  `_tool_config` accepts — there is no second code path that can create demo data
  the product itself would reject. Two real bugs surfaced from writing it this
  way, both in the script: `SET x = :param` is not parameterisable in Postgres
  (`set_config()` is), and disposing the async engine from a second
  `asyncio.run()` floods the exit with `Event loop is closed` — the same
  loop-affinity trap `workers/async_bridge.py` exists to solve.
- **Spend was ~$0.02, against a $1.50–2.50 estimate.** The budget model assumed
  prompt iteration would dominate. It did not, because the prompts were written
  against a corpus that had been read rather than guessed at, and because the
  structured-output schemas do most of the constraining that a prompt would
  otherwise have to. Remaining budget is essentially untouched.

### The gap this phase closed that was not on the list

"Run now" sent an empty `trigger_payload` and there was no UI to supply one —
recorded in the day 1 notes and never actioned. Two of the three demo workflows
extract from a payload, so without this they were unrunnable from a browser and
the phase's own gate could only be met from a terminal. `RunWorkflowDialog` plus
the pure `lib/trigger-payload.ts` closes it; blank input still parses to `{}`, so
the one-click path the HR assistant is demoed with is unchanged.

---

### Days 13–14 notes

**The `#how-it-works` anchor was a scroll position, not an element.** Three
links pointed at it — the nav, the footer and the hero's "Watch a run" — and all
three had been silent no-ops since 2026-08-13, when the 3D scene replaced
`run-film.tsx` and took the section that owned the id with it. The obvious
repair, putting the id on the scene's root, lands the reader at progress 0,
which is the hero they are already looking at. What both links mean is the *run*
scene, at 0.52.

The scrub is `start: "top top"` / `end: "bottom bottom"` over a 420vh container,
so progress `p` is reached at `p × (420 − 100)` vh into it. A zero-height div at
that offset is a real hash target, and native navigation, `scrollIntoView` and a
cold load with the hash already in the URL all then work with no listener.
`sceneAnchorTopVh` derives it from the same `SCENES` table the scrub reads, so
retiming the run moves the anchor with it. Verified live: clicking the nav link
landed at scrub progress **0.5200** and rendered the run scene's first beat.

**The audit viewer deliberately does not poll.** Every other list in the product
polls, because a run's status changes underneath the reader. An audit row
physically cannot change — Postgres rejects UPDATE and DELETE on that table — so
the only thing a poll could surface is a *new* row, and a trail that reorders
itself mid-read is worse than one refreshed deliberately.

**`actor_email` was worth the backend change.** The rows store a bare `actor_id`
and nothing in the API resolves a user id to a name, so the page would have
rendered hex strings. One LEFT JOIN, guarded on `actor_type = 'user'` because
the column is polymorphic (`models.py`: users.id *or* agent_sessions.id), plus
one response field. A governance screen full of UUIDs is a governance screen
nobody reads.

**Two items are still open and neither is code**: the landing page on a real
phone, and the three-minute walkthrough. Both need hardware.

---

### Members + invitations — an unplanned day, and what it cost

Not in this plan. It came out of a question — *where do we assign roles?* — whose
honest answer was **nowhere**. Worth recording, because the gap was invisible
from the code: the tables, the five seeded roles, the `member:invite` /
`member:remove` permission strings and the `invited | active | suspended` column
all existed and looked finished. Nothing wrote them. Exactly the shape
`audit_logs` was in before day 2026-08-09 and `trigger_type` before triggers.

Three decisions worth not relitigating:

- **Signed invite links over direct-add.** Direct-add was one endpoint and no
  token, but it puts someone in your organization without their consent and
  leaves the `invited` status the schema models permanently unused. The link
  also works for a person who has never used the product, which is the actual
  demo scenario — the alternative required them to self-register first, which
  drops them in their own empty org.
- **`GET /members/me` over a JWT role claim.** A claim would gate the UI
  synchronously on first paint, but access tokens live 15 minutes, so a demoted
  user keeps their old role in the UI until rotation. One request per session is
  cheaper than explaining that.
- **The last-Owner rule is a 409, not a warning.** An org with no active Owner
  has nobody holding `"*"`, and every repair path is itself Owner-gated. It is
  unrecoverable without database access.

**Cost to the plan:** roughly a day, drawn against day 15's buffer. The two
remaining days 13–14 items still need hardware — a real phone, and a screen
recording.
