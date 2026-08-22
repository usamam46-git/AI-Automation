# Orkest shakedown — running fix list
(2026-08-19, from driving the UI end to end)

## A. Fixes to the Shakedown artifact (my documentation errors)

1. **DONE (published)** — Config JSON blocks were framed as input. They are stored
   shapes; the UI is forms throughout. Relabelled + form controls described.
2. **DONE (published)** — "paste the KB id from its URL" removed; there is a
   "Search in" dropdown listing KBs by name.
3. **DONE (published)** — `is_mutating` on knowledge_search: switch is *hidden*,
   not rejected-in-UI.
4. **DONE (published)** — `{"type":["string","null"]}` advice replaced with the
   schema builder's Nullable checkbox.
5. **DONE (published)** — "Nothing validates payload_fields at publish" corrected:
   missing required keys AND bad path roots are both flagged on the canvas. Only a
   typo after a valid root is silent.
6. **DONE (published)** — Node keys. The artifact says "Node keys must match exactly" and uses
   `extract`, `policy_lookup`, `fx_rate`, `assess`, `route`, `auto_note`,
   `post_to_erp`. Those are NOT achievable: `nextNodeKey()` in
   `lib/node-catalog.ts:118` auto-assigns `<prefix>_<n>` and there is no rename
   control. Rewrite the whole phase-03 spec + every dotted path against the real
   keys: start_1, agent_1, tool_1, tool_2, agent_2, condition_1, approval_1,
   tool_3, tool_4, end_1. Also state that creation ORDER determines the numbering.

## B. Product observations (for the team, not doc fixes)

1. **DONE (2026-08-20) — Node keys are now renameable.** The config panel's
   header is an editable key field; `lib/node-rename.ts` rewires the edges and
   retargets every `node_outputs.<key>` path in downstream configs and edge
   conditions. Original observation below.

   **Node keys are not renameable.** Auto keys make a ten-node graph hard to read
   on the canvas and make every dotted path opaque (`node_outputs.agent_2.
   account_code` vs `node_outputs.assess.account_code`). The state paths are
   authored by hand against these keys, so unreadable keys directly raise the
   chance of the one error nothing catches (typo after a valid root). Worth a
   rename affordance, or at least a display label shown on the node.

2. **Automation-only:** controlled inputs in the node inspector lose all but the
   last character when filled faster than React can round-trip through the graph
   store. Not reachable at human typing speed. Noted only so future automation of
   this runbook uses direct value-set rather than synthetic keystrokes.

## C2. Artifact status as of 2026-08-19 end of session

All items in section A are now published. Section D findings are also folded into
the artifact: real node keys throughout, creation-order warning, Tool-node
inline-by-default warning, the tool-execution-log argument for registry mode,
and the edge Value typing hint.

Nothing in section A or D is outstanding. Section B item 1 (rename affordance)
remains a product suggestion for the team, not a doc fix.

## C. Still to verify (phases not yet reached)

**All five CLOSED on 2026-08-21 — see section G below for the results.**

- 04 guardrail / cycle / orphan / unknown_tool
- 05 signed webhook + three forgeries + quota untouched
- 06 approval hold, approve, reject, auto branch, dashboard denominator
- 07 manual + cron
- 08 audit log, immutability trigger, quota 429

## D. Confirmed while building the graph (2026-08-19)

- **My payload_fields correction was right.** `tool_4` showed
  "Missing at run time: vendor, amount, account_code" and narrowed it live to
  just `account_code` as each mapping was filled. Publish-time is not the only
  gate — the canvas catches missing keys incrementally.
- **Edge condition typing is surfaced.** Entering `true` flipped the hint to
  "Typed as a boolean". The artifact should mention this — it is the answer to
  "will my `true` be a string?".
- **Registry picker annotates mutating tools** with an amber `writes` tag, and
  the node inspector shows a read-only registry summary card
  ("Spend Policy · top 5 · score ≥ 0.3"). Worth adding to the artifact as the
  visible proof of registry-owned fields.
- **Inline vs registry has a stated audit consequence** in the UI:
  "An inline tool leaves no row in the tool execution log — that trail needs a
  registry tool to point at." The artifact frames inline-vs-registry only in
  terms of the override merge; this audit angle is a better reason to prefer
  registry and should be quoted.
- **Tool node defaults to Inline config.** The artifact says "Use registry mode
  today" but does not warn that every Tool node starts on Inline and must be
  switched. Easy to miss on 4 nodes.

## E. Graph as actually built (real keys, for the artifact rewrite)

start_1 → agent_1 → tool_1 → tool_2 → agent_2 → condition_1
condition_1 --[node_outputs.agent_2.requires_approval eq true]--> approval_1
condition_1 --[fallback, no condition]--> tool_3
approval_1 → tool_4 ; tool_3 → tool_4 ; tool_4 → end_1

- agent_1 in: trigger_payload
- tool_1 query_fields: query <- node_outputs.agent_1.summary
- tool_2: fx_lookup, no override
- agent_2 in: node_outputs.agent_1, node_outputs.tool_1, node_outputs.tool_2
- tool_3 (inline POST postman-echo) body_fields: vendor/amount <- agent_1,
  reason <- node_outputs.agent_2.rationale
- tool_4 payload_fields: vendor/amount <- agent_1, account_code <- agent_2

## F. After publishing (2026-08-19, end of session)

Workflow "Purchase request review" was PUBLISHED. This confirms **∃-semantics**:
`tool_4` is mutating and the `tool_3` fallback branch reaches it without an
approval, yet publish succeeded because `approval_1` is an ancestor on one path.
The artifact already predicts this; the run confirms it.

Consequence for phase 04:
- **Test D changes.** `tools/service.py:211` (`count_published_references`)
  409s a tool delete while a published version references it. So deleting
  `fx_lookup` now yields a 409, NOT `unknown_tool` on the canvas. Run it as a
  409 check; to also see `unknown_tool`, use a throwaway tool referenced only
  from a draft.
- Artifact TODO: say that the phase-04 ordering assumes the graph is still a
  draft, and give the published-workflow variant of Test D.
- Artifact TODO: tool delete is a SOFT delete, deliberately, so `tool_executions`
  keeps the audit trail. Worth stating in phase 02 and phase 08.

---

# Session 2 — 2026-08-21: phases 04–08 driven end to end

Section C is now closed. Every phase from 04 to 08 was executed against the live
stack, mostly through the browser UI, as Owner on org `7d73af44`. The workflow is
**"Purchase request review" v2** (v1's graph, republished after the phase-04
teardown). Total OpenAI spend for the session: **under $0.01**.

## G. Phase results

- **04 Test A — mutating guardrail: PASS, and better than documented.** Deleting
  `approval_1` flagged `tool_4` red **on the canvas immediately** ("tool_4 writes
  to an external system but has no human approval step upstream"), and Publish
  still called the API and got a real **HTTP 422** naming `['tool_4']`. The draft
  saved; v1 stayed live. The artifact implies the 422 is the only signal — the
  canvas pre-empts it, and the toast ("Publish rejected — see the highlighted
  nodes") does not name the node; the node highlight and the config panel do.
- **04 Test B — cycle: PASS.** Every node in the loop flagged, with the full path
  spelled out: "Cycle detected: agent_1 → tool_1 → tool_2 → agent_2 → agent_1.
  Loops are not supported yet."
- **04 Test C — orphan: PASS.** "Not connected: agent_3…" inline; the draft saved
  with the orphan in the DB and publish 422'd naming it. **Note the ordering:**
  structural validation runs before the mutating-approval walk, so a graph broken
  both ways reports the orphan first.
- **04 Test D — both halves: PASS.** Deleting `fx_lookup` (referenced by a
  published version) gave **409**, rendered *in the dialog*, not a toast:
  "Cannot delete tool because 1 node(s) in published workflow version(s)
  reference it." The `unknown_tool` canvas rule was then proven with a throwaway
  tool referenced only from the draft — delete returned 204, and the node showed
  "tool_2 points at a tool that is no longer in the registry."
- **05 — signed webhook: PASS on every point.** Genuine request → **202**.
  Forged signature, stale timestamp (−4000s) and unknown workflow UUID all
  returned a **byte-identical 401** (`{"detail":"Invalid or missing webhook
  signature."}`). The org's quota counter stood at **1** afterwards — forged
  requests burn nothing.
- **06 — the gate: PASS.** A run held at `waiting_approval`; the derived sentence
  read **"Approve 48,000.00 EUR to Acme Vendor LLC?"** with the policy citation
  rendered as evidence. Approve → resumed → `completed`, `MOCK-…` confirmation
  carrying `account_code: "6110"` read out of the corpus. Reject → `rejected`
  with `tool_4` **never executed**. Duration on the approved run was **69.4s**
  including the human wait, confirming `_started_at_first_leg_only`.
  Dashboard then read **100.0% · "2 runs · last 30 days"** — the rejected run
  excluded from the denominator, exactly as designed.
- **07 — other triggers: PASS.** Manual "Run now" on a *webhook* workflow works
  and says so in the dialog; the payload box accepts and pretty-prints JSON.
  Cron fired unattended within the 60s tick, ran to `completed`, logged
  `actor_type: system` / `trigger: schedule`, and re-armed `next_run_at` to the
  next day's boundary. Timezone maths verified: a 22:05 `Asia/Karachi` cron armed
  to 17:05 UTC.
- **08 — governance: PASS.** Raw `UPDATE` and `DELETE` on `audit_logs` both
  rejected **by Postgres** (`reject_audit_log_mutation()`), not by app code. No
  secret appears anywhere in `metadata` (grepped for `whsec_`/`sk-`: 0 rows).
  Quota dropped to 2 → **202, 202, 429** with `Retry-After: 24737` (to 00:00 UTC);
  `infra/.env` restored and `api` restarted afterwards.

## H. New findings (2026-08-21)

1. **FIXED — `http_request` treated a 3xx redirect as a successful result.**
   httpx defaults `follow_redirects=False`; a 3xx is below 500 and not in
   `_RETRYABLE_STATUS`, so `_run_http_request` classified it as "a definitive
   answer from the server". `tool_2` called `https://api.frankfurter.app/latest?
   from=EUR&to=USD`, which now 301s at Cloudflare, and stored
   `{"status_code": 301, "body": "<html>…301 Moved Permanently…"}` as the FX
   rate. The agent downstream reasoned over that HTML and **nothing reported a
   failure anywhere**. `get_http_client` now sets `follow_redirects=True` and
   `max_redirects=5` (both overridable). Two tests pin it. Note the residual
   edge, documented in the docstring: httpx strips `Authorization` across
   origins but **not** a custom header like `X-API-Key`.
   Side effect worth knowing: this node cost **18.8s** of every run's duration.

2. **The approval gate fires on retrieval uncertainty, not on risk.** The
   sharpest finding of the session, and it is a graph-design problem rather than
   an engine bug. `tool_1`'s query is mapped to `node_outputs.agent_1.summary` —
   a *product description* — so it retrieves the **coding guide** and never the
   spend-authority threshold table. Observed, on one published graph:
   - **EUR 4,200** ("Component assembly AC-2291-B") → retrieval confidently
     returned the coding guide's worked example → `requires_approval: false` →
     the auto branch → **posted to the ledger with no human involved**, despite
     `policy.md` §3.1 requiring approval for anything ≥ EUR 1,000.
   - **EUR 85** (calibration standard) → retrieval was vague → `requires_approval:
     true` → held at the gate.

   So the cheap purchase was escalated and the expensive one was not. The agent
   *can* follow the "if the retrieved text does not cover this case, set
   requires_approval to true" instruction — it did so twice — but on the 4,200 run
   it decided the text *did* cover the case, because coding guidance genuinely
   matched the description. **This is what ∃-semantics costs in practice**
   (section F predicted the shape; this is the live consequence): the fallback
   branch reaches a mutating node with no gate, so the safety of the whole graph
   rests on one LLM boolean. Options worth discussing, none applied unilaterally:
   retrieve against the *decision* rather than the description, add a second
   retrieval for thresholds, or put a deterministic value condition upstream of
   the branch so money — not prose — decides.

3. **`workflow.run.quota_exceeded` is NOT written on the HTTP paths** — only by
   the schedule tick (`workers/trigger_tasks.py`). The artifact's phase 08 claims
   the row appears after a 429; it does not. Deliberate per
   `_claim_run_quota`'s docstring, but it means a tenant hitting its ceiling
   through the API leaves no trace in the trail an admin would look at.
   **Artifact fix required; product decision optional.**

4. **Webhook-triggered runs are audited as `actor_type: system` with no IP.** The
   caller of the one unauthenticated route in the product is the one caller whose
   IP is most worth keeping, and it is the one that is dropped. Defensible (there
   is no authenticated actor) but worth a look.

5. **Cost (MTD) renders `$0.00` for any sub-cent month.** Three runs costing
   $0.0036 showed as `$0.00` on the dashboard while the per-run rows correctly
   showed `$0.0012`. During development every figure is sub-cent, so the card
   reads zero permanently.

6. **The workflow detail dialog shows the version UUID, not the version number.**
   "Version: ba9bd9f9-74b2-4443-a50c-1f087854adc2" where the builder header, the
   run header and the toast all say "v2".

7. **Confirmed, no action:** the B2 controlled-input character-loss issue is
   specific to the node inspector — the Run-now payload textarea accepted a
   200-character JSON body typed at full speed with nothing dropped.

## I. Artifact corrections still to publish

- Phase 04: the canvas flags Test A, B, C and D **inline before Publish**; say so.
- Phase 04 Test D: give the published-workflow variant (409) as primary, per F.
- Phase 02 / 08: state that tool delete is a **soft** delete — the dialog already
  says "Existing runs and the tool's execution history are kept".
- Phase 03 `tool_2`: the expected `status_code: 200` FX body is now only true
  because redirects are followed (finding H1); `api.frankfurter.app` 301s.
- Phase 08: remove the claim that a `workflow.run.quota_exceeded` audit row
  appears after an HTTP 429 (finding H3).
- Phase 03 / Reference: **node keys ARE renameable** as of 2026-08-20
  (`lib/node-rename.ts`). The "there is no rename control anywhere" warning and
  the "cannot be renamed" line in the Reference table are both stale.

---

# Session 3 — 2026-08-22: H2 closed, plus two engine limitations found in the process

## J. Status of the section-H findings

- **H1 (redirect) — CLOSED 2026-08-21 in code.** `get_http_client` follows
  redirects (max 5). Nothing further to do; the artifact's phase 03 now says so
  and keeps the note, because a successful-looking status over a meaningless body
  is the exact shape of a silent tool failure and is worth teaching.
- **H2 (gate fires on retrieval uncertainty) — CLOSED 2026-08-22 by graph
  redesign.** No product change, and deliberately none: the *seeded* flagship
  demo (`Invoice approval` in `src/db/demo/graphs.py`) was never affected — it
  already routes on `check_amount` (`total_amount > 1000`) with the structured
  DSL and retrieves against a purpose-built `policy_question`. The bug was in
  the **runbook graph the artifact's phase 03 teaches**, which retrieved against
  `node_outputs.agent_1.summary` — a product description — and let one LLM
  boolean guard the mutating write. Both halves are now fixed in the artifact:
  `extract` emits a `policy_question` and retrieval searches on that, and a
  deterministic `check_amount` decides on the money before any model opinion is
  consulted.
- **H3 (no `workflow.run.quota_exceeded` row on the HTTP paths)** — still open as
  a product decision. The artifact correction was already published.
- **H4 (webhook runs audited as `actor_type: system`, no IP)** — still open.
- **H5 (Cost MTD renders `$0.00` sub-cent) — FIXED 2026-08-22.**
  `formatMonthlyCost` in `apps/web/lib/dashboard-stats.ts` now uses 4 decimals
  for a non-zero figure below `$0.01`. Exact zero stays `$0.00`; the $0.01–$1
  band keeps 2 decimals, so the docstring's existing "`$0.0412` as a headline
  looks like a rendering bug" reasoning is untouched. 3 tests.
- **H6 (detail dialog shows the version UUID) — FIXED 2026-08-22.**
  `Workflow.current_version` (viewonly, `lazy="joined"`, explicit `foreign_keys`
  for the circular FK pair) + a `current_version_number` `@property`, surfaced as
  `WorkflowResponse.current_version_number`. The dialog renders `v2`. 1 test that
  publishes twice, which is what proves the relationship reloads rather than
  serving a warm identity map.

## K. Three engine facts found while fixing H2

Found by checking whether the obvious H2 fix — *amount over threshold **OR** the
model flagged it → the same approval node* — is expressible. It is not. Only the
first was fixed; the other two are recorded, not closed.

1. **FIXED — condition-edge evaluation order was unspecified.**
   `WorkflowVersion.edges` carried no `order_by` and `_build_condition_router`
   (`src/graphs/compiler.py`) is first-match-wins over that list, while
   `evaluate_condition` returns `True` for an edge with no predicate. So a
   catch-all fallback that happened to sort first made every predicate behind it
   dead code and **silently skipped the branch they guard** — on this graph, the
   approval gate in front of a mutating ERP write. It only ever worked because a
   plain select over unmodified rows tends to come back in insertion order.
   Now: `_ordered_condition_edges` sorts catch-all edges last, then by
   `(created_at, id)`; `has_predicate()` moved into `condition_eval.py` and is
   used *by* `evaluate_condition` so the two definitions of "matches everything"
   cannot drift; `order_by` added to the relationship. The `id` tiebreak is
   load-bearing — `save_draft` deletes and re-inserts every edge in one
   transaction, so `created_at` ties across the whole graph. 3 tests.
2. **OPEN — two edges between the same pair of nodes are not authorable.**
   `edgeId` in `apps/web/lib/graph-mapping.ts` is `` `${source}->${target}` `` and
   edge ids are derived rather than persisted, so a parallel edge collides with
   the first and one is lost on the next round trip. Nothing warns. Fixing it
   means persisting edge ids or folding a condition hash into the derived id.
3. **OPEN — condition nodes cannot chain.** `_compile_state_graph` skips
   condition nodes as LangGraph nodes and attaches the router to the condition
   node's *predecessor*, so a `condition → condition` edge puts a key in the
   `path_map` that was never registered. Nothing validates it — not
   `validate_graph_structure`, not `lib/graph-validation.ts` — so it fails at
   compile, after publish. The workaround (and what the artifact now teaches) is
   an ordinary node between the two conditions.
