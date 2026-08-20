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
