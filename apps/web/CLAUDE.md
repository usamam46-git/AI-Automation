@AGENTS.md
# apps/web — Frontend Instructions

Next.js (App Router) + TypeScript + Tailwind + shadcn/ui + React Query +
Zustand + Framer Motion. See root CLAUDE.md for cross-cutting rules; this
file is frontend-specific only.

## State management — strict split, don't blur this

- **Server state** (anything from the API): React Query only. Query keys
  are hierarchical arrays, e.g. `['workflows', orgId, workspaceId]`.
- **Client/UI state** (selection, panel open/closed, builder mode):
  Zustand only.
- **Local component state**: `useState`/`useReducer`.
- If a piece of state could be derived from a GET request, it belongs in
  React Query — never duplicate server data into Zustand.
- No optimistic updates for archive/delete/publish/approve actions — wait
  for server confirmation. Optimistic updates are fine for low-risk actions
  like renaming.

## Design system — locked values, do not deviate

The product uses an iOS/macOS-inspired visual language. Full detail in
`docs/blueprint/volume-3-frontend-architecture.md` §3.1, summarized here:

- **Corners**: `rounded-xl` (cards/panels/modals), `rounded-lg`
  (buttons/inputs/badges), `rounded-full`/`rounded-2xl` (avatars). Nothing
  sharp-cornered.
- **Shadows**: soft, low-opacity only (`shadow-black/5`–`/10` in light
  mode). Never a hard single drop-shadow.
- **Dark mode — important**: TRUE BLACK, not shadcn's default blue-tinted
  slate. `--background`: `0 0% 4%`–`0 0% 7%`. Card surfaces: `0 0%
  9%`–`0 0% 11%`, neutral gray. Borders: `white/10`–`white/15`. This is a
  deliberate override in `globals.css` under `.dark` — never regress to
  shadcn's untouched dark defaults.
- **Density**: compact, macOS System Settings / Linear-level density, not
  marketing-page whitespace.
- **Document scrollbar** (`globals.css`, added 2026-08-11): thin silver
  (`#c3c7cf`) floating pill in light, `white/18` in dark, driven by
  `--scrollbar-thumb*` tokens. Two things to know before touching it.
  **(1) The standard and `-webkit-` mechanisms are mutually exclusive.**
  Chromium ignores `::-webkit-scrollbar` completely whenever `scrollbar-width`
  or `scrollbar-color` is set to a non-initial value — declaring both at once
  silently discards the rounded thumb and leaves the stock bar. The standard
  properties are therefore the Firefox baseline, and an
  `@supports selector(::-webkit-scrollbar)` block resets them to `auto` so
  Chromium/Safari use the pseudo-elements. To tell which path is live, measure
  `innerWidth - documentElement.clientWidth`: 12px is the pseudo-element path,
  11px is the standard `thin` path.
  **(2) `html:has(.mk-root)` forces the light thumb on marketing routes.** The
  scrollbar lives on `<html>`, which carries `.dark`, but the marketing page is
  light-locked inside it — without the override a dark-system visitor gets a
  dark scrollbar on a white page. `:has()` takes its argument's specificity, so
  that rule is (0,1,1) and beats `.dark` at (0,1,0) regardless of order.
  Rules are scoped to `html`, never bare `::-webkit-scrollbar`, so the
  ScrollArea primitive and the builder canvas keep their own treatments.
- **Motion**: subtle only, 150–250ms ease-out, no springy overshoot.
- This will apply to the marketing site too — it should not become a
  visually separate "brochure site." `app/(marketing)/` was built on
  2026-08-11; see its own section below for the one deliberate divergence
  (a committed light-only palette with its own `mk-` token namespace).

## API integration

- Single API client in `lib/api-client.ts`. Access token held in memory
  only, never localStorage. Response interceptor attempts one silent
  `/auth/refresh` on 401 before redirecting to login.
- Org/workspace context: Zustand (session state), not React Query.
- **`currentWorkspaceId` is persisted to `localStorage`** (2026-08-16, key
  `orkest.workspace`) and the shell **reconciles it against the fetched list on
  every load**. Both halves are load-bearing. Without persistence it started
  `null` each load and the shell fell back to `workspaces[0]`, so an org with two
  workspaces silently changed workspace on every reload. Without reconciliation a
  *stored* id that no longer resolves — workspace archived, or a different user
  on the same browser — would sit in the store filtering every list by an id the
  API never matches, while the header displayed `workspaces[0]`: an app that
  looks empty for no visible reason. Logout clears it. The access token is still
  memory-only; that rule is untouched and this is a workspace UUID, not a secret.

## Workflow builder canvas

Built as of 2026-08-06 (canvas, config panel, validation, autosave/publish).
`@xyflow/react` (not the legacy `reactflow`). Route:
`app/(dashboard)/workflows/[workflowId]/builder/`.

- **Node identity**: the React Flow node `id` **is** `node_key`. Never use
  `NodeResponse.id` — `save_draft` replaces the whole row set, so those
  UUIDs are regenerated on every save and are unusable as canvas ids. Edge
  ids are likewise derived (`source->target`), not persisted. `node_key` is
  assigned at creation and read-only in v1; renaming would mean rewriting
  every referencing edge.
- **The graph lives in the React Query cache**, under
  `['workflow-graph', workflowId, versionId ?? 'new']`. React Flow runs
  controlled and `onNodesChange`/`onEdgesChange` write back via
  `queryClient.setQueryData`. Two settings on that query are load-bearing:
  `staleTime: Infinity` and `refetchOnWindowFocus: false` — the global
  `QueryClient` default is `staleTime: 20_000`, and a background refetch
  would silently overwrite the canvas mid-edit. Autosave must likewise not
  invalidate this key on success. `stores/workflow-builder-store.ts` holds
  **annotations only** (selection, panel open, schema editor mode) — no
  graph data.
- **React Flow theming is not optional**: the stock stylesheet ships
  light-mode blue-tinted-slate defaults that clash with the true-black dark
  theme. `components/workflow-builder/builder.css` maps every `--xy-*`
  variable onto our tokens under a `.builder-canvas` scope. Verify both
  themes after touching it.
- Node metadata (label, icon, tint, key prefix, which handles exist, blank
  config) is data in `lib/node-catalog.ts`, and one card component is
  registered for all seven types. Don't fork per-type components.
- There is no `trigger` node type. `NodeType` is
  `agent | tool | condition | human_approval | subgraph | start | end`;
  `trigger_type` is a field on the workflow shell.

### Node config panel — the config shapes are a contract

`agent` nodes carry their settings **inline** in node `config`, because the
agents module is models-only. `tool` nodes have **two** sources as of
2026-08-12 — see the next subsection. The forms in
`components/workflow-builder/{agent,tool}-config-form.tsx` construct exactly
the shapes `_agent_config` / `_tool_config` in
`apps/api/src/graphs/node_handlers.py` accept. Changing either side means
changing both, in the same commit.

Three rules that are easy to break and expensive to debug:

- **`is_mutating` must be a real JSON boolean.** It is a `Switch`, never a
  text field. A string `"true"` is rejected at invoke time and reads as
  non-mutating in the publish-time approval gate.
- **`output_schema` emits only `type` and `properties`** — never `required`
  or `additionalProperties`, which `_normalize_strict_schema` injects. There
  is no "required" toggle by design: strict mode makes every property
  required, so optionality is a nullable type. Rules live in
  `lib/output-schema.ts`; read its header first.
- **`condition` is edge state, not node state.** Condition nodes have no
  config at all — they compile into routing functions and never reach
  `node_handlers.py`. `human_approval` has no config either; do not invent a
  message-template field.

`python_function` and `mcp` are rejected by name at the backend and must not
appear in the tool-type dropdown.

### Tool nodes: Registry vs Inline (2026-08-12)

`tool-config-form.tsx` offers a **Source** selector, and the two paths are
mutually exclusive because they are not symmetric on the server: `_tool_config`
reads `tool_type` first, so **inline always wins** and a node carrying both is
an inline node with a dead `tool_id`. Showing both at once would let someone
edit a picker that has no effect, so switching source *clears the other path's
keys* rather than layering them.

- **Registry mode** writes `tool_id` only. Just it and the four
  `NODE_OVERRIDABLE_KEYS` (`body`/`body_fields`/`payload`/`payload_fields`) are
  editable; `url`/`method`/`headers`/`action`/`timeout_seconds`/`is_mutating`
  render read-only off the registry row. That split is not cosmetic — a node
  that could re-point a reviewed tool would leave the publish gate reading
  `is_mutating` off a row that no longer describes the call.
- **Inline mode** is unchanged and stays supported forever. It is still the
  default for a freshly dropped node, because `node-catalog.ts`'s blank config
  is a shape apps/api/CLAUDE.md pins as one the backend must keep accepting.

**`sourceOf()` tests `"tool_id" in config`, not its truthiness.** Switching to
registry writes `tool_id: ""` before a tool is picked; reading that as "no
tool_id" bounced the panel straight back to the inline fields while the toggle
showed registry. Observed in a browser, not theorised.

Switching to registry also drops a node-level `is_mutating`, so a node cannot
carry a stale upgrade past a tool it no longer references.

### Validation is duplicated in two languages — keep them in sync

`lib/graph-validation.ts` mirrors all eight backend rules from
`apps/api/src/modules/workflows/service.py`. This is a real drift risk and
the reason the vitest suite exists. In particular the mutating-approval walk
is **∃-semantics** (flag only when *zero* `human_approval` nodes exist
upstream); tightening it to ∀ would reject the blueprint's own Vol. 5 §1 and
§5 workflows and diverge from the server.

**The 2026-08-08 under-reporting divergence was closed on 2026-08-12.** The walk
used to read `config.is_mutating === true` only, so a node that was mutating
*because its registry `tool_id` points at a mutating row* validated clean on the
canvas and then 422'd at publish. `validateGraph` now takes an optional
`ToolRegistry` (`ReadonlyMap<toolId, isMutating>`), which the builder page
supplies from its own tools fetch, and two rules read it:

- the mutating walk ORs the registry flag in — a node may **upgrade** but never
  **downgrade**, so `is_mutating: false` beside a mutating `tool_id` is still
  mutating. This half applies even to a node also carrying inline `tool_type`,
  because `validate_mutating_approval` does not exempt those either.
- the new `unknown_tool` rule mirrors `_resolve_registry_tools`' FK check: a
  `tool_id` resolving to nothing is flagged, *unless* the node carries inline
  `tool_type` (inline is the supported non-registry path, and a stray
  forward-compat `tool_id` beside it is a documented no-op).

**`undefined` and an empty Map are not the same thing** and the distinction is
load-bearing: `undefined` means "not loaded" and skips both rules, while an empty
Map means every `tool_id` on the graph is dead. The builder passes `undefined`
until the fetch resolves, or every registry-backed node would flash a wrong
`unknown_tool` error on each load.

One knowing divergence remains, in the safe direction: the server's
`_referenced_tool_ids` silently drops a `tool_id` that is not a well-formed UUID,
so a malformed one is never reported at publish. This reports it, because the
node is equally broken either way (`_tool_config` raises on both at invoke time)
and the picker cannot produce either.

The server's 422 stays the authority. `parseValidationDetail()` recovers node
keys from its mostly-unstructured `detail` strings; anything unattributable
renders as a toolbar banner rather than being dropped. Publishing is
hard-blocked only by the two draft-integrity rules — shape and approval
problems still go to the server, so a validator divergence surfaces as a real
422 instead of being hidden by a disabled button.

### Autosave

800ms debounce → `POST /workflows/{id}/versions` with the **complete** node
and edge set; the endpoint replaces the draft's rows, so there is no delta
path. Dirtiness is derived, never stored: `graphSignature()` (order-independent
by design — the server returns rows in its own order) compared against
`savedSignature`. Publish is disabled while unsaved, or it would publish the
previously stored graph.

**`savedSignature` must live in the query cache, never in component state**,
and must be advanced on every successful save. It was briefly component state
with a cache fallback that was never advanced, which produced a nasty bug:
closing and reopening the builder remounted the hook with an empty baseline
while the cache entry survived (`staleTime: Infinity` — no refetch), so the
unchanged graph read as dirty and autosaved. On a *published* version that
silently created version N+1, byte-identical to N, and the builder then showed
"draft" for a workflow the user had just published. `useWorkflowAutosave` now
takes the baseline as a required prop and holds no state of its own, so a
remount cannot lose it. Not covered by a test — `apps/web` has no React test
harness, only node-environment tests over pure `lib/` modules.

### Tests

`npm test` (vitest) covers the pure `lib/` modules only —
`graph-validation`, `graph-mapping`, `output-schema`. Canvas drag/drop, panel
rendering and React Flow theming are deliberately uncovered; they are verified
manually in the browser.

## Scope discipline

- Every page must handle loading (Skeleton, not a bare spinner), empty
  (calm centered state + primary action), and error (retry-capable card)
  states — not optional polish. The builder's empty case is the one
  exception to "centered state + primary action": it renders a
  `pointer-events-none` hint over a live canvas, because a blocking
  EmptyState would make the empty canvas undroppable.

## Execution Viewer

Built 2026-08-07 (Vol. 3 §6). `app/(dashboard)/executions/page.tsx` (list) and
`[runId]/page.tsx` (timeline), `components/executions/*`, plus two pure modules
`lib/run-status.ts` and `lib/run-timeline.ts` covered by vitest.

- **Live status is polling, not WebSocket.** `refetchInterval` ~2.5s on the
  detail page, 10s on the list page and only while a rendered run is
  non-terminal. `isTerminalRunStatus()` in `lib/run-status.ts` is the single
  predicate deciding when to stop — if the two pages ever disagree about
  terminality, one of them polls forever. Vol. 2 §9.2's
  `WS /api/v1/ws/executions/{run_id}` is still unbuilt; there is no Redis
  Pub/Sub fan-out on the backend.
  Note React Query pauses interval polling while `document.visibilityState`
  is `hidden` and refetches on focus. That is wanted behaviour, but it means a
  background tab looks frozen — don't "fix" it by setting
  `refetchIntervalInBackground`.
- **The timeline needs the version, not just the run.** `NodeExecution` stores
  only `node_key` — never `node_type` — so icons come from joining the run's
  published version's nodes, fetched with `workflowsApi.getVersion` under its
  own `['execution-version', ...]` key. Never reuse the builder's
  `['workflow-graph', ...]` key: that entry is the live editable canvas graph
  at `staleTime: Infinity`, and writing to it would corrupt an open builder.
  The version is also the only source for nodes that have not run yet (§6.1's
  `○` rows) — `node_executions.status` is `succeeded|failed|skipped` only.
- **`interrupt_payload` carries no prompt text.** `human_approval_handler`
  emits `{type: "approval_request", node_outputs: {...}}` and nothing else, so
  the approval bar renders a fixed headline plus those upstream outputs as the
  evidence. §6.1's wireframe shows a domain sentence ("Approve $4,200.00 to
  Acme Vendor LLC?") that cannot be derived from this. Do NOT invent a
  message-template field on `human_approval` — it has no config by design.
- **`current_node_key` is not trustworthy for highlighting.** On interrupt the
  engine writes the literal string `"human_approval"`, not the node's real key,
  so a node keyed `approval_1` never matches. `buildTimeline` prefers
  `current_node_key` when it resolves to a real node and otherwise falls back
  to the first un-executed `human_approval` node. Pinned by a test; don't
  simplify it back to a straight equality check.
- Run-status badge variants live in `components/ui/badge.tsx` alongside the
  workflow-shell ones, deliberately. Vol. 3 §5 names `--color-status-*` tokens
  that do not exist in this codebase — that cva IS the status vocabulary, so
  extend it rather than forking a parallel token set.
- No "View raw trace in LangSmith" link from the §6.1 wireframe: the LangSmith
  hook in `LLMClient` is a no-op, so the link would be dead.

## Home dashboard (2026-08-10)

Vol. 3 §5.1. `app/(dashboard)/dashboard/page.tsx`,
`components/dashboard/{stat-card,recent-executions,workflow-tiles}.tsx`, and the
pure `lib/dashboard-stats.ts` (vitest-covered).

- **It lives at `/dashboard`, not `/`.** Vol. 3 §1.1 gives `/` to
  `(marketing)/page.tsx`, and Next.js errors when two route groups resolve to
  the same path — so a `(dashboard)/page.tsx` could never coexist with the
  marketing landing. `app/page.tsx` is a placeholder that redirects to
  `/dashboard`; it is the file the marketing landing replaces.
- **Login and register both land here**, changed from `/workflows` at the same
  time. That was only ever the target because no home page existed.
- **`success_rate: null` must render as "—", never "0%".** Null means nothing
  has finished in the window, not that everything failed. `formatSuccessRate`
  is a separate function precisely so that decision has one home.
- **The three queries reuse the Executions and Workflows pages' exact query
  keys** (`['executions', orgId, 'all', 'all']`,
  `['workflows', orgId, workspaceId, 'all']`). That shared cache is the point —
  navigating to either list is instant. Do NOT add a `limit` to those calls: it
  would fork the key and double the fetching. The trim is client-side in
  `recentRuns`/`workflowTiles`.
- **Stat cards are org-wide, workflow tiles are workspace-scoped.** Deliberate,
  and it matches the wireframe's own header (org AND workspace switcher): Cost
  MTD is a billing figure and billing is per-org, while "Your Workflows" is the
  set you're working in. The backend has no workspace filter on the stats.
- `formatMonthlyCost` **hardcodes `$` and the thousands separator** rather than
  using `toLocaleString(undefined, {style: "currency"})`, which renders
  "USD 842.10" under some locales while `lib/run-status.ts`'s `formatCost`
  hardcodes `$` — the two would disagree on the same page. It is also distinct
  from `formatCost` on purpose: 2dp for a monthly total, 4dp for a per-run cost.
- Stat-card accents are Tailwind palette classes mirroring `badge.tsx`'s run
  statuses (sky/amber/emerald), not `--color-status-*` tokens — that token set
  does not exist here, as the Execution Viewer section above already notes.

## Workflow triggers (2026-08-09)

`components/workflows/workflow-dialog.tsx` (cron input) and
`components/workflows/webhook-secret-card.tsx`, surfaced from the workflow
detail dialog.

- **`triggerTypes` is deliberately shorter than the `TriggerType` union.**
  `email` and `event` stay in the type (the DB and API still know those values)
  but are no longer offered, because the backend now 422s them
  (`IMPLEMENTED_TRIGGER_TYPES` in `modules/workflows/service.py`). Keep the two
  lists in sync — offering a rejected value produces a dialog that fails on
  submit, and before 2026-08-09 they were offered AND accepted, which produced
  a workflow that silently never ran.
- **A `schedule` workflow must be created WITH a cron.** `trigger_config: null`
  is a 422 for that type, which is why the dialog collects the expression
  inline instead of deferring it to a later edit.
- **The webhook secret is shown exactly once.** No read endpoint can recover it
  — `Workflow.has_webhook_secret` is a bare bool, not a masked fragment, because
  no prefix of an HMAC key is safe to expose. So the revealed value lives in
  component state, is gone on dialog close, and the copy affordance has to be
  present while it's visible. Don't add a "view secret" action; there is
  nothing behind it.
- **Rotation has no grace window** — the old secret dies immediately. The button
  says "Rotate" and warns for that reason; don't relabel it as idempotent.
- 403 on minting is a permanent explained state (it's `workflow:publish`-gated,
  which Editor does not hold), not a retryable error — same treatment as the
  Owner-only OpenAI key card.
- "Next run" renders "Not until published" for a draft. The beat tick filters on
  `status='published'`, so showing a timestamp there would promise a run that
  never comes.

## Marketing landing page (2026-08-11)

Vol. 3 §1.1. `app/(marketing)/{layout,page}.tsx`, `components/marketing/*`,
`app/api/contact/route.ts`, and two pure vitest-covered modules
`lib/{run-film,contact-form}.ts`. **`app/page.tsx` was deleted** — it was the
placeholder redirect its own docstring said the landing would replace, and two
route groups cannot both resolve to `/`. The dashboard still lives at
`/dashboard`; login/register still land there.

New deps: `gsap` (with ScrollTrigger), `@number-flow/react`, `canvas-confetti`.
New `components/ui/`: `interactive-hover-button.tsx`, `accordion.tsx`. New
hooks: `use-media-query.ts`, `use-gsap-reveal.ts`.

- **It is light-only, on purpose, and that is enforced by `.mk-root`.**
  `next-themes` puts `.dark` on `<html>`, so the marketing layout re-declares
  the full light token set on a wrapper class in `globals.css`. That is what
  makes the shadcn primitives inside (Button, Select, Switch, Accordion) render
  light under a dark system theme. The sky hero, near-white body and lime CTA
  are a single committed design — a dark variant would not be a variant, it
  would be a different page. App routes are untouched and keep both themes.
- **The `mk-` colour namespace is deliberate.** `--color-mk-sky`, `--color-mk-lime`
  etc. exist so marketing hues can never collide with Tailwind's own `sky`/`lime`
  scales, and so nothing on the marketing page can drift the product's neutral
  tokens.
- **The hero gradient's stops are a contrast contract, not a look.** The text
  block sits in the top ~15–50% of `SkyBackdrop`, where the sky stays at or
  below `#1878CC` — 4.46:1 against white, which carries the 17–18px subhead.
  The reference image's own `#4AA8F5` is **2.55:1 and fails even large text**;
  that is why the palette is deepened. Lighten stops below 50% only.
- **The aurora is additive light over that gradient, and its envelopes exist
  for legibility, not looks.** `aurora-canvas.tsx` is a raw WebGL fragment
  shader — deliberately not three.js/R3F, which are installed but would cost
  ~160KB gzipped on the landing page's LCP to draw one quad. Because it blends
  with `mix-blend-mode: screen` *underneath* white text, every unit of glow it
  adds costs contrast. Three things keep that safe, and all three are load-bearing:
  a cubed vertical falloff that puts nearly all energy above the headline, a
  centre-column dim over the text, and a top rolloff (`smoothstep(0.0, 0.11, st.y)`)
  that keeps the peak from landing under the floating nav — without it the glow
  blew out to white and took the wordmark with it.
  **Measured composite worst case: eyebrow 5.76:1, headline 4.97:1, subhead
  4.66:1.** If you touch `MAX_INTENSITY` or either envelope, re-measure —
  sample the canvas pixels, screen-blend against the analytic gradient colour
  at that y, and check against white. Do not eyeball it.
- **The shader lives in a JS template literal, so its GLSL must contain no
  backticks.** A backtick in a GLSL comment silently ends the string and the
  route 500s with a parse error. This happened.
- **The aurora paints one frame synchronously before any rAF.** Same reasoning
  as `runWhenVisible` below: a background tab never runs rAF, so a canvas that
  only draws from the animation loop would show an empty hero until
  foregrounded. It also gives reduced-motion users a real, still aurora rather
  than nothing. Everything is additive over a gradient that is complete on its
  own, so no WebGL, a lost context, or a shader compile failure all degrade to
  exactly the sky that shipped before — never to a blank hero.
- **Every `gsap.from(..., {opacity: 0})` is guarded by `runWhenVisible`.** This
  is the single most important rule here. Such a tween blanks its targets the
  moment it is built and relies on the ticker to bring them back — but
  `requestAnimationFrame` does not run in a background tab, so a page opened via
  cmd-click built every tween, blanked every section, and froze there. This was
  observed live, not theorised. `useGsapReveal` (scroll reveals) and the two
  inline guards in `hero.tsx` / `hero-collage.tsx` all defer setup until
  `document.visibilityState === "visible"`, and clear inline props on complete
  so a finished section is styled only by its classes. **Do not add a new GSAP
  entrance without this guard.**
- **Tailwind's `scale-*` / `translate-*` compile to `transform`, which GSAP
  overwrites.** The hero collage sets depth scale and the focal card's centring
  through the standalone CSS `scale` / `translate` properties instead, because
  the pointer parallax writes `x`/`y` to `transform` continuously. A card that
  silently snaps to full size on first mouse move is this bug.
- **The 2D run film is gone; `lib/run-film.ts` is not.** `run-film.tsx` and
  `run-inspector.tsx` were deleted when the 3D scene took over the centrepiece
  slot (2026-08-13). The *module* was deliberately kept: its beat list is the
  script the 3D run scene plays. See the 3D-scene section below.
- **The film is fiction that must stay technically true.** `lib/run-film.ts`
  uses real `WorkflowRun` statuses and its tests pin the load-bearing invariant:
  on the approval beat `approval_1` is `waiting` while `post_to_erp` is still
  `pending`. If that ever flips, the page is claiming the ERP was written to
  before a human approved — the exact opposite of its argument. The 3D scene now
  renders that invariant directly as an unwritten ledger card.
  Its `FILM_NODES` / `beatIndexAtProgress` exports are no longer used by any
  component — they survive because `run-film.test.ts` covers them and because a
  future run-detail surface is the obvious consumer. Do not prune them without
  checking that test.
- **No invented social proof.** The reference layout's star rating is replaced
  by capability facts, because the product has not shipped and any rating would
  be fabricated. Keep it that way.
- **`system-marquee.tsx` names real vendors but shows no vendor logos, and the
  heading says "connect to" — not "trusted by".** Both halves are deliberate.
  Reproducing the marks would mean shipping trademarked assets or redrawing
  them from memory, and a subtly wrong Workday logo is worse than none. And a
  logo wall under a hero reads as customers-or-integrations, neither of which
  is true yet: the FAQ on this same page says purpose-built ERP connectors are
  roadmap, and that an integration today is an HTTP tool you configure. The
  claim made here is compatibility (every system listed has an HTTP API, which
  the tool registry speaks), and the strip's closing line repeats the FAQ's
  wording so the two cannot drift.
  If real logos are ever added, the heading and the FAQ must change together.
  **Coloured monogram tiles were tried and removed** — standing in for a mark
  you cannot ship reads as an impression of a logo wall, which is worse than
  either real logos or plain names. Names in the display face are honest about
  being names. Don't reintroduce the tiles.
  Renamed from `capability-marquee.tsx` — it previously listed the platform's
  own feature vocabulary, which asked the reader to parse feature names two
  seconds after the headline.
- The marquee uses a real `mask-image` alpha fade, not a paper-coloured overlay,
  so the edges cannot show a seam. It pauses on hover **and on focus-within**,
  the latter so a keyboard user tabbing past is not chasing a moving target.
- **NumberFlow prints a literal `$` with `style: "decimal"`, not
  `style: "currency"`.** It shipped as "US$49" on first render under a non-US
  locale. Same trap and same fix as `formatMonthlyCost` in `lib/dashboard-stats.ts`.
- **The contact endpoint fails loudly rather than silently.** With no
  `CONTACT_WEBHOOK_URL` set it returns 503 and the form shows an email address.
  A form that says "thanks, we'll be in touch" while dropping the submission
  loses real leads and nobody notices. Set that env var (server-side only —
  never `NEXT_PUBLIC_`) to a Slack/Zapier/internal hook to turn it on.
- **Not verified: any real mobile viewport.** Chrome zooms rather than reflows
  when resized under automation here, so the layout viewport stayed pinned at
  1440 and no breakpoint was ever exercised. Desktop was verified in a browser
  across every section. The responsive classes and the `lg`-gated pin are
  reasoned, not observed — check them on a real device before launch.

## 3D scene — "The Company Comes Alive" (all 5 phases done, 2026-08-13)

A scroll-scrubbed WebGL narrative that is now **the landing page's opening**, and
that replaced both the sky-gradient hero and `run-film.tsx`. Verified in a
browser at every scene.

**The page opens inside the office.** First paint is a room with this company's
paperwork lying on the desk, the hero headline above it, and the four-scene
narrative running from there as scrolling lifts the documents off the surface.
The previous opening was a blue sky gradient with an aurora shader and a collage
of floating UI cards; the product owner's call was that the page should start in
the office instead. `hero.tsx`, `sky-backdrop.tsx`, `aurora-canvas.tsx` and
`hero-collage.tsx` are **deleted**; the hero's words live on in `hero-copy.tsx`
over the room.

> **As of 2026-08-14 that room is a PHOTOGRAPH, not geometry.** Read
> "The room is a PHOTOGRAPH now" below before changing anything in the opening —
> it supersedes several rules in this section, which are struck through where
> that applies.

It **opens on an actual desk** — a surface with the company's paperwork lying on
it, lit and casting real contact shadows — and the documents then lift off and
disperse into the field. That opening is load-bearing rather than decorative: it
gives the sequence a physical starting point a viewer already recognises, so the
airborne field reads as *this company's work in the air* rather than as objects
that were always floating. It is also the honest staging of the section's first
sentence — the work is already happening, on a desk, right now.

Files: `lib/{scene-script,document-cards}.ts` (both vitest-covered),
`public/desk-room.jpg`, `components/marketing/hero-copy.tsx` and
`components/marketing/scene/{core-scene,core-scene-section,room-plate,
office-room,document-field,document-texture,connection-edges,ai-core,
cluster-labels,mark-collapse}.tsx`.

**Deleted in Phase 5:** `components/marketing/{run-film,run-inspector}.tsx` and
the throwaway route `app/(marketing)/lab/`. **`lib/run-film.ts` was kept** and is
now load-bearing — see below. **Deleted 2026-08-14:**
`components/marketing/scene/wood-texture.ts`, unreferenced once the modelled
desk became a plate.

**243 frontend tests** (110 over `scene-script` alone); `tsc --noEmit`, `eslint`
and `npm run build` clean.

### The room is a PHOTOGRAPH now (2026-08-14)

The modelled room — wall, floor, procedural walnut desk, apron — is gone.
`public/desk-room.jpg` is a real office shot, composited *under* the transparent
canvas by `components/marketing/scene/room-plate.tsx`, and the documents are
still real geometry sitting on a real solved plane above it. The brief was that
the opening frame be genuinely realistic and that the realism survive the
transition into the narrative.

Read this section before touching the opening. Several of the rules below
**supersede** ones in "The settled decisions" that follows, and each says so.

- **`PLATE_DESK_EDGE_NDC` (-0.4463) is measured, not chosen, and everything
  hangs off it.** A per-row luminance scan of the plate finds one dominant step
  in the lower frame at y=478/661 — blurred dark interior (~95) to lit sharp oak
  (~212). If the plate is ever replaced or cropped, **re-measure**: the camera
  solve, the card band, the `object-position` and the wash all derive from it.
  The scan is a dozen lines (mean row luminance across the centre 40%, then the
  largest step in the lower half) and lives in the task history, not the repo.
- **The opening camera is exactly LEVEL, and that is load-bearing.** Verticals in
  the plate show no keystoning, so it was shot with the sensor plane vertical.
  Level also collapses the projection to `y = -h / (d·tanHalf)`, which is what
  makes `PLATE_DESK_EDGE_Z` and `DESK_FORESHORTEN` solvable in closed form
  instead of eyeballed. A test asserts `target[1] === position[1]`.
- **Camera height is the document-size knob.** `y = 0.25` puts the lens 5.2 units
  above the paper (~1.3 document widths — a low product-shot camera, which is
  what the plate's own framing implies). A card is a fixed 4 units wide and its
  on-screen size is `~5.3/d`, so raising the camera shrinks every document. The
  first pass at this plate kept the old `y = 1.5` and the paperwork came out too
  small to read. A test pins the near/far on-screen widths.
- **`object-position` and `transform-origin` are BOTH the desk-edge fraction
  (72.31%), and this is the alignment.** `object-cover` crops to fill, so the
  photographed edge slides with viewport aspect unless it is anchored — and the
  3D camera projects the tabletop to a *fixed* NDC. Anchoring at the edge's own
  height fraction makes it aspect-invariant: with vertical overflow `Hd - Hc`,
  taking `f` of it off the top puts the edge at `f·Hd - f·(Hd - Hc) = f·Hc`.
  **This was a real bug, not a hypothetical:** at an eyeballed `62%` the
  documents floated ~0.08 NDC above the wood, standing on the furniture.
- **Contact shadows are what weld paper to plate, and the gap is what makes them
  visible.** `office-room.tsx` is now a single `ShadowMaterial` plane. The
  catcher sits `CATCHER_DROP` (0.11) *below* the card rest plane — it was 0.02,
  the right number for avoiding coplanar artefacts and the wrong one for
  casting. The key light is ~50° off vertical, so a card `g` above the surface
  displaces its shadow by `~1.2g`; at 0.02 that lands **underneath the card that
  cast it** and the papers read as stickers. The cards did not move — moving
  them would change `h` and invalidate the whole solve — so the gap is opened
  downward, where a transparent plane is invisible. Also `shadow-normalBias`,
  not a big `shadow-bias`: normal-offset is the right tool for thin flat
  geometry and does not peter-pan the shadows the scene depends on.
- **The desk documents are a PILE, not one plane — `DESK_STACK_STEP` (2026-08-15).**
  Desk sheets are allowed to overlap (`DESK_OVERLAP`, which is what makes the
  shot read as a desk in use), but every one of them used to sit at exactly
  `CARD_REST_Y`. About **fifty of the roster's pairs overlap**, so those pairs
  had *precisely coplanar* printed faces and the depth buffer had no basis to
  pick one — their text flickered between the two documents on the opening frame
  as the camera damping and the pointer sway moved the view by a fraction of a
  pixel. Same failure `CARD_REST_Y` already fixes for card-versus-desk; this is
  card-versus-card. Fixed with a real height rather than a depth bias, because
  paper stacks: each sheet is raised `0.004` above the one below, so the pile
  sorts itself, casts correct contact shadows and cannot fight on any renderer.
  **Measured, not assumed** — with the step at 0 a progress delta of 0.0004
  (sub-pixel) flipped **552 pixels** spread right across the pile; with the step
  in, **0**. The step is threaded into `placeOnDesk` rather than added
  afterwards, so the far-edge rule is checked at the sheet's true height, and
  `byDepth` is walked in reverse so the **near, readable sheets end up on top**.
  Keep it tiny: raising a sheet climbs it up the frame toward
  `PLATE_DESK_EDGE_NDC` and slides its contact shadow out from under it.
- **The key light is on the LEFT and warm, bounded to the plate's lifetime.**
  This is a **deliberate, scoped divergence from "the lights were the beige"**
  below. That rule diagnosed a warm key multiplying a near-white *modelled* room;
  here the room is a photograph that is genuinely warm and the only thing the key
  lights is paper. White light on white paper in a visibly warm room is the
  composite tell in colour, as the wrong shadow direction is in geometry.
  `keyLightWarmthAtProgress` reaches exactly 0 at `LIFTOFF_END` and a test holds
  it there for the rest of the page — scenes 2–4 are lit exactly as neutrally as
  before. The hemisphere and fill stay neutral throughout, so warmth has one home.
- **Intensity went 2.1 → 2.7 when the key moved, and that is arithmetic.** The
  old key at `[9,22,12]` dotted a flat card's up-normal at 0.83; this one at
  `[-16,15,9]` at 0.63. Holding intensity dimmed every sheet by a quarter and the
  documents came out grey. Grey paper is the thing the scene is trying not to be.
- **The plate defocuses BEFORE it fades.** A sharp image dissolving reads as the
  room being deleted — as a picture being removed. Pulling focus first and
  drifting forward reads as a camera leaving a room, which is the whole point of
  the handoff. Implemented as a cross-fade to a **pre-blurred twin** rather than
  an animated `filter`: a full-screen filter re-evaluated every scroll frame is
  the expensive way to do it and looks no better. A test asserts the ordering.
- **The pointer sway is suppressed while the plate is up.** A photograph is a
  fixed viewpoint and cannot parallax. At full sway (2.6 units) the documents
  skate across a stationary tabletop by ~9% of frame width on every mouse move.
  `swayScaleAtProgress` holds 0.15 while the room is present and the plate is
  translated to match, inside a `PLATE_OVERSCAN` of 1.03 so no edge is revealed.
  The transform has **two drivers** — the scrub and the pointer — so
  `writePlateTransform` is called from both `applyImperative` and the pointermove
  handler, not just the former.
- **The grade is minimal because this plate does not need saving.** Its
  background is **optically** out of focus while the tabletop is sharp, which
  does three jobs at once: the room reads as really photographed, the upscale is
  invisible where the image is already soft, and the copy lands on a low-detail
  field. A synthetic edge-defocus was built for the *first* plate and removed
  with this one — a synthetic blur over a real one is just a second blur, and it
  softened the one region that must stay crisp. Grain stays, light (0.04): it
  gives the WebGL documents and the photographed table one shared surface noise,
  which is quietly a large part of why they sit together.
- **The image is `unoptimized`, and `priority` is deprecated in Next 16.** The
  optimizer would upscale server-side and re-encode — hundreds of KB to invent
  detail not in the file. Use `loading="eager"` + `fetchPriority="high"`; the
  `qualities` config now defaults to `[75]`, so a bare `quality={92}` would fail.
- **The `loading` fallback renders the plate, frozen.** Identical markup at
  identical geometry, so the swap when the scene chunk lands is invisible rather
  than a flash of grey — and a visitor whose JS never arrives still gets the shot.

#### Hero copy contrast over the plate — measured, and re-measure if you touch it

`hero-copy.tsx` used to carry a docstring saying the copy "needs no shadow, no
scrim and no envelope". True of a flat #f2f2f5 modelled wall; **void over a
photograph**, where the copy crosses about three stops from the window to the
bookcase. Two independent failures had to be fixed together:

1. **Translucent ink has a contrast ceiling no background can lift.** Ink at 45%
   reaches only ~3.4:1 on *pure white*, so `text-mk-ink/45` measured 1.0:1 — not
   marginal, invisible. `text-mk-ink-soft` (#5c5f66) had the mirror problem: a
   mid-grey always finds a mid-tone in a photograph to vanish into, and measured
   1.0:1 at **every** wash strength tried. Tones are now 80/70/90/85%, so the
   hierarchy comes from weight rather than transparency.
2. **A 45% white wash on the plate**, whose lower stop is the table edge so it
   dies exactly where the wood begins — hazing the timber would flatten the one
   sharp region and veil the documents. It scales about the same anchor, so the
   stop stays welded to the edge under the push-in.

Measured on the shipped page at 1600×776, worst 8px patch **per text line**
(`Range.getClientRects()`, vertically inset 18% for ascender slack — per element
box flatters the numbers by including leading and ragged right edges):

| Line | Ratio | Needs |
|---|---|---|
| Eyebrow, 11px | 4.75:1 | 4.5 |
| Headline line 1, 68px | 6.22:1 | 3.0 (large) |
| Headline line 2, 68px | 4.08:1 | 3.0 (large) |
| Subhead, 18px | 4.59:1 | 4.5 |
| Proof row, 13px | 5.66:1 | 4.5 |

Every worst patch lands at x≈1000 — the dark bookcase edge. That is the spot to
check first. **Do not eyeball this**: composite the plate with the wash into a
canvas, resolve the computed colour through a 1×1 canvas (`getComputedStyle`
returns `oklab()` here, and naively regexing its numbers reads the lightness as
the red channel and flatters every ratio by ~10%), then sample per line.

**The CTAs no longer sit on the desk.** That was a deliberate touch when the desk
was an empty band; this table is a working surface with twenty documents on it,
and the copy block now stops above the edge.

### The settled decisions — do not re-litigate these

- **The palette is macOS light mode, and it is NEUTRAL.** `--mk-paper` is
  #f5f5f7 — the system light background macOS itself uses — and `--mk-mist` is
  #ececef. The scene\'s gradient stops are those same two tokens; keep them in
  step. Greys here must never be warm: the page went through two rounds of
  "why does this look beige" and warm greys were half the answer.
- **THE LIGHTS WERE THE BEIGE, NOT THE PALETTE.** This is the one to remember.
  The key light was `#fffaf2`, the fill `#fff4e6` and the hemisphere ground
  `#d8d3c9`. Every surface — near-white backdrop, white paper, grey room — was
  being multiplied by a warm light, so the whole section read as beige while
  every hex value in the source said otherwise. Chasing it through the palette
  found nothing, twice. **If the room ever looks warm again, check the lights in
  `core-scene.tsx` before touching a single colour.**
  **Amended 2026-08-14:** the KEY light is now deliberately warm from progress 0
  to `LIFTOFF_END`, to match the photographed room, and neutral for the whole
  rest of the page. See the plate section above for why that does not
  reintroduce this bug. The hemisphere and fill are unchanged and stay neutral
  throughout. Everything this rule was originally about still holds.
- **The hero copy is server-rendered and must stay that way.** It sits in the
  page tree, not inside the `ssr: false` dynamic import — the scene cannot be
  prerendered (it touches `window`, WebGL and ScrollTrigger), so putting the H1
  inside it would take the page\'s largest text out of the initial HTML and make
  a WebGL canvas the LCP element. Backdrop paints first, headline second, canvas
  last.
- **The hero scrolls away AND fades.** It is positioned in the first viewport of
  the scroll container while the canvas behind it is `sticky`, so scrolling
  lifts it off-screen for free. Scrolling alone is not enough though: a full
  viewport of travel means the headline is still visible when the scene\'s own
  caption arrives, and the page carries two competing blocks of copy.
  `heroOpacityAtProgress` and `sceneCaptionOpacityAtProgress` share a handover
  point so the crossfade is clean, and a test asserts both are never legible at
  once.
> **The five rules that follow are SUPERSEDED (2026-08-14).** The modelled room
> and its procedural walnut desk were replaced by `desk-room.jpg` and
> `wood-texture.ts` was deleted. They are kept because their *reasoning* is still
> live — the paper-needs-something-to-be-lighter-than requirement is satisfied by
> the plate's mid-tone oak (#c19f77), and the warm-desk-in-a-neutral-room balance
> is now the plate's own. Do not rebuild any of this in three.js.

- ~~**The room is a wall, a floor and a desk with a real front edge.**~~ A single
  plane read as paper on a light void. What makes a space legible is a floor, a
  wall to close the distance, and a slab with visible **thickness and an apron**
  under the front edge — an infinite plane has no edge and never becomes
  furniture.
- ~~**The desk top is a full step darker than the wall, for legibility not
  taste.**~~ The documents on it are white; against a near-white surface they
  washed out to unreadable. Paper needs something to be lighter *than*. *(Still
  true, and still the reason the plate's tabletop works.)*
- ~~**The desk is real polished walnut, and it is the one warm thing in the
  frame.**~~ An earlier pass argued against wood on the grounds that a brown
  rectangle is a foreign object on a near-white site, and built a grey desk
  instead. That was wrong and the rendered result settled it: white paper on a
  near-white desk had nothing to be lighter *than* and washed out completely.
  The timber is what finally makes the documents read, and it gives the shot the
  one note of material warmth that stops a near-white room looking like an empty
  render. **The room around it stays strictly neutral** — the contrast is the
  point, and a warm room plus a warm desk is where the beige came from.
- ~~**The grain is procedural (`wood-texture.ts`), and the polish is in the
  MATERIAL not the map.**~~ `MeshPhysicalMaterial` with a clearcoat over the grain
  is what puts a soft specular sheen on the surface; the same texture on a
  `MeshStandardMaterial` looks like printed laminate. Three things make wood
  read as wood, in order: grain lines running one way with varied width and
  spacing, **cathedral figure** (the stretched arcs of a growth ring — this is
  what separates wood from "brown surface with stripes"), and slow tonal drift
  so no two areas are the same value.
- ~~**The wood map must not tile.**~~ Its left and right edges do not meet, so any
  `repeat` above 1 puts a hard vertical seam straight down the middle of the
  desk — the single most visible thing in the opening frame. One board across
  the whole surface.
- ~~**The room fades with `depthWrite` ON, and that is a fix not a detail.**~~ The
  desk is a *box*: with depth writing off you see straight through its top face
  into its own underside and far side, three layers of dark walnut blending
  together. It read as the desk turning black the instant the first scroll
  began. Writing depth is safe because the room is behind and below everything
  else — the documents are opaque and draw first. A fading surface also stops
  casting, or its shadow outlives it and leaves a dark rectangle lying on the
  floor with nothing above it. *(The shadow-catcher still stops casting as it
  fades, for the second half of this reason.)*
- **The room holds solid, then dissolves quickly** (`platePresenceAtProgress`,
  which reuses `deskPresenceAtProgress`'s curve).
  A long slow alpha fade on a solid wooden object spends most of its transition
  as a half-transparent thing, which never looks like anything real. By the time
  it starts the camera has already begun to climb, so the desk is leaving frame
  anyway.
- **The brand lime is deepened (#b9d94a / #94b52c, was #c8f536 / #a9d617).**
  The original was an electric neon that worked on the old blue-gradient hero
  and read as harsh against macOS-light greys and walnut — the two loudest
  things on the page were the buttons. The hero's secondary button also moved
  from `ink` to the `quiet` tone: a solid black pill beside a lime one is two
  heavy buttons competing, and a secondary should not shout.
- **The desk edge is a hard contrast line and the hero copy is spaced around
  it.** Everything above it is the blurred room and reads normally; the wood
  below carries twenty documents and must stay clean. **Amended 2026-08-14:**
  the whole copy block now clears the edge, buttons included. They used to be
  allowed to cross it because paper behind an opaque pill reads as a button
  sitting on a desk — true when the desk was an empty band, wrong now that it is
  a working surface. See the plate section above for the measured contrast.
- **The scene is a DAYLIGHT ROOM.** Near-white ground, white paper cards,
  near-black ink, one lime accent, amber only on approval gates. **Nothing is
  emissive.** The first version opened on the hero's sky and descended into a
  near-black void with a neon point-cloud core and indigo/violet objects; it was
  **rejected by the product owner on sight**, for two reasons worth keeping
  written down: indigo-gradient space is the default look of every AI landing
  page, and an abstract particle field says nothing about back-office software.
  If a future session reaches for a dark background, a coloured rim light, bloom,
  or a glowing anything — that path has been walked and rejected.
- **The objects are readable documents, not abstract solids.** This is the whole
  point. `lib/document-cards.ts` holds real specs and `document-texture.ts` draws
  each to a canvas mapped onto a card. **Do not abstract these back into
  geometry.**
- **One company, one consistent set of facts.** The finance thread reuses
  `run-film.ts`'s exact data — Acme Vendor LLC, `INV-2291`, `4,200.00`, the
  `extract_invoice` requester. `document-cards.test.ts` pins the chain
  (`PO-4471 → GR-2214 → INV-2291 → JE-99120`) and that the gate reads `Waiting`.
- **A box takes six materials, and index 4 is the printed face.** BoxGeometry's
  order is +x, −x, +y, −y, +z, −z. One material maps the document onto all six
  faces, putting mirrored body copy on the back and a stretched sliver down each
  edge.
- **No `@react-three/postprocessing`.** Still not a dependency. The scene is
  physically lit rather than additive, so there is nothing for bloom to do.

### The composition is computed and asserted, not eyeballed

This is the largest thing Phase 1 added, and it exists because the first frame
anyone actually looked at was wrong in three ways at once.

- **The layout is composed at `LAYOUT_PROGRESS` (0.22), not at progress 0.**
  Progress 0 is the desk. Composing the airborne field against the desk camera
  would place it for a shot it is never seen in, so every rule — copy safe zone,
  frame-edge, depth schedule — is evaluated at the first moment the field is
  actually the subject. Tests must pass `LAYOUT_PROGRESS` too; several were
  passing a literal `0` and silently measuring the desk.
- **`projectAtProgress` / `unprojectAtProgress` are real camera maths in a pure
  module.** The layout composes the opening frame by projecting candidate card
  positions through the camera, so rules like "nothing behind the copy" are
  *tested* rather than hoped for.
- **Positions are sampled in SCREEN space and unprojected**, not sampled in world
  space and hoped to land well. The region that is simultaneously near enough to
  read, inside frame, clear of the copy and off the camera axis is a narrow
  annulus; uniform world sampling finds it about once in a hundred tries and the
  sampler simply failed to place its 17th card.
- **A spherical shell projects to an annulus.** The original scattered field was
  a shell, which is why the first frame had a hole through the middle and cards
  packed into the corners. No seed fixes that; the distribution was the bug.
- **The opening frame cannot hold the whole roster.** Twenty legible cards need
  about half the frame once the copy block is excluded. `DEPTH_SCHEDULE` places
  **12 of 20 in frame** and pushes the other 8 outside it. A card must be wholly
  inside or wholly outside — **never straddling an edge**, which reads as a
  rendering fault.
- **Inside and outside are judged at DIFFERENT aspect ratios** (1.6 and 2.4). The
  fov is vertical, so a wider window reveals more world horizontally: cards
  parked off a 16:9 frame reappeared, clipped, in the corners of a 1512×798 one.
- **Spacing scales with on-screen size** (`requiredGap`), and is measured on the
  *drawn* size while frame-edge and copy collisions are measured on the
  *drift-inflated* footprint. Mixing those up is how an early "cards are big
  enough to read" assertion passed while every visible card was too small — the
  inflation, not the card, was carrying it.
- **`DRIFT_MARGIN` and the drift amplitudes in `document-field.tsx` must stay in
  step.** The layout reserves screen space for exactly that excursion. `scale` is
  drawn *before* placement for the same reason: a sampler that does not know a
  card is 1.25× is wrong by a quarter.
- **The hero reserves a SHAPE, not a rectangle.** `HERO_SAFE_ZONE` is the wide
  upper band; `HERO_CTA_CHANNEL` is a narrow strip covering **only the last line
  of small text**. Reserving one rectangle for the whole hero left the desk a
  band 0.68 NDC tall to seat documents 0.8 NDC tall and exactly two fitted;
  reserving space for the buttons too emptied the entire lower centre and put a
  hole through the middle of the shot. The buttons are opaque pills — paper
  behind them reads as buttons sitting on a desk, which is what they should look
  like. **Text needs a clean background; a solid button does not.** This is also
  why the proof facts were moved above the buttons: small grey text was the
  lowest element and forced the reserved band far too deep.
- **The desk and the airborne field get SEPARATE PRNG streams.** Both samplers
  draw inside one loop, so with a single stream the number of attempts the desk
  takes shifts every subsequent airborne draw — retuning the desk camera by two
  units moved the airborne field and made a pinned card unplaceable. A change to
  one composition must not silently break the other.
- **A steep desk shot and a tall wall behind it cannot coexist**, and it is worth
  knowing before retuning the opening camera. Camera pitch sets where the horizon
  lands: at 40 degrees down the horizon is off the top of frame and there is no
  wall to be seen, which is why the opening uses a shallow angle and pays for it
  with foreshortened documents. Steeper means bigger, more readable paper and no
  room; shallower means a room and smaller paper.
- **`NAV_SAFE_TOP` (0.76 NDC) keeps authored layouts out from under the floating
  nav pill**, which is drawn over the canvas on every frame of this page. The
  desk shot put its back row of documents directly beneath it. The rule is
  deliberately asymmetric — only the top of frame has furniture in it.
- **Foreshortening applies to SPACING, not to framing.** A card lying flat on
  the desk presents about two thirds of its height to the camera but its *full
  width*. `framing` derives the horizontal half-extent from `radiusY`, so
  handing it a flattened radius under-reports width by a third and documents get
  sliced by the left and right frame edges. Framing uses the upright
  (conservative) footprint; only the neighbour test uses the flattened one.
- **Desk documents are allowed to overlap** (`DESK_OVERLAP`, half the airborne
  gap). Paper on a desk overlaps, and that is what makes it read as a desk in
  use rather than as a filing system. Spacing the desk with the *upright*
  footprint and the airborne gap seated exactly two documents on the whole
  surface.
- **When the visible desk is full, the rest go off to the SIDES, not further
  back.** Pushing them deeper puts them near the top of frame where they land in
  the straddle band, get rejected, and the sampler exhausts its attempts and
  throws.
- **`COPY_SAFE_ZONE` is ±0.46 NDC**, derived from the copy block being
  `max-w-3xl` (768px) and centred. It was ±0.62 first, which left near cards
  nowhere to go.

### The clusters, the run, and the ending

- **Cluster members sit on a RING, not a jittered cloud.** A card is 4 world
  units wide; five scattered inside a ±4.5 box *must* overlap, and the settled
  graph read as four piles of paper. `clusterRadius` divides out
  `CLUSTER_RING_SQUASH` or the top and bottom of each ring still touch.
- **The four clusters are a balanced 2×2, not a diamond.** A diamond puts one
  cluster at bottom centre — exactly where the copy sits.
- **Scene 2 pulls the camera BACK, it does not push in.** Moving to z=19 while
  the field was still ninety units wide put the viewer inside the web: every edge
  became a scaffolding pole and nothing read as a connection.
- **Scene 3 is `run-film.ts`'s beat list mapped onto scroll — not a second
  script.** This is why that module was kept rather than deleted. `runBeat*`,
  `erpWrittenAtProgress` and `heldAtGateAtProgress` all derive from
  `nodeStatesAtBeat`, so the scene cannot drift from the film's own tests.
- **The load-bearing invariant is now a VISUAL fact.** `run-film.ts` pins that
  `post_to_erp` is `pending` while `approval_1` waits. In 3D that drives which
  *printing* of the ledger card renders: at the hold **JE-99120 has no debit, no
  credit and no period, and is stamped NOT POSTED / Awaiting approval**. When the
  gate clears the figures appear. If this ever inverts, the scene is showing the
  ERP being written to before a person approved.
  Note the ledger therefore reads NOT POSTED from the *first* frame of the page,
  before the run has been introduced. That is deliberate and literally true —
  nothing has been posted yet — and it makes the fill-in at the tool beat a
  payoff. Do not "fix" it by showing the ledger written and then blanking it;
  un-writing a ledger is worse.
- **Scene 3 recedes the rest of the room** (`documentPresenceAtProgress`) and
  **stages the run's five documents in execution order** (`RUN_STAGE`). The first
  version of the hold had eleven unrelated cards in shot with the caption running
  across an invoice. A scene that says "here is one run" should not show the whole
  company at the same time. Receded cards drop `depthWrite` — a faded card that
  still writes depth punches a hole in what is behind it.
- **The ending collapses into the Orkest mark, and the approval gates land in the
  OPEN MIDDLE NODE.** `MARK_NODES` is derived from `orkest-mark.tsx`'s 24×24
  viewBox so the two cannot drift. The open centre *is* the human-approval step,
  so the two approval requests in the room are exactly what belongs there — the
  mark in the nav turns out to be a picture of what the visitor just watched.
- **`coreIntensityAtProgress` vs `coreVisibilityAtProgress` are deliberately
  separate.** Ignition never dims (the core does not stop reasoning); only
  visibility goes at the collapse.

### Traps, including two that cost hours

- **R3F does not keep your `uniforms` object by reference — the material gets a
  clone.** A component that memoises a uniforms object and mutates
  `myUniforms.uIntensity.value` every frame is writing to something nothing
  renders. The failure is *completely silent*: shaders compile, meshes are in the
  scene, `useFrame` runs, and every uniform sits at its initial value. Treat the
  `uniforms` prop as initial values only and drive everything through a ref on
  the `<shaderMaterial>`.
- **Declare `precision` identically in BOTH shader stages** or the program fails
  `VALIDATE_STATUS` and draws nothing with only a console warning.
- **Neither trap can currently fire: there is no custom shader left in the
  scene.** The core, the edges and the mark are all stock `meshStandardMaterial`
  driven by transforms and instanced matrices. That was cheaper *and* more
  correct than the shader version. Keep it that way unless a phase genuinely
  cannot be done without a pass.
- **`react-hooks/immutability` correctly rejects mutating a memoised value from
  `useFrame`.** Reaching `materials[4]` from a `useMemo` array and assigning
  `.map` is an error. Reach the same object through the mesh ref
  (`mesh.material as THREE.MeshStandardMaterial[]`) instead — same object, no
  rule violation, and the rule is right that a memoised value should not be
  rewritten from a frame loop.
- **`LineBasicMaterial.linewidth` is ignored by every WebGL renderer.** Edges are
  thin boxes so they can be one pixel thick *and* take light and cast shadow.
- **Edges taper rather than fade**, because all chain edges share one material —
  per-edge opacity would need per-edge materials.
- **Cluster labels need `depthTest: false` and a `renderOrder`.** Without it a
  card drifting in front slices a cluster name in half, which reads as a clipping
  bug rather than as depth.
- **Same no-backtick-in-GLSL rule as `aurora-canvas.tsx`** if a shader ever
  returns.
- **The scrub never enters React state.** `onUpdate` writes progress into refs and
  one DOM style; `setState` fires only when the discrete scene index — or, in
  scene 3, the discrete beat — changes. `applyImperative` stays split from
  `applyProgress` so the reduced-motion path composes its still frame without a
  `setState` inside an effect.

### Verifying this under browser automation

Automation runs the page in a **background tab**, where `requestAnimationFrame`
never fires — GSAP's ticker is frozen, ScrollTrigger never processes a scroll,
and R3F never renders. `window.__orkestScene` and `window.__orkestApplyProgress`
exist for this (both `NODE_ENV !== "production"` only).

```js
// Derive the range from the DOM. A hardcoded multiple of the viewport (it was
// 3.2 = (420vh - 100vh)/100) silently drifts the moment the window resizes,
// and you land in the wrong scene without noticing.
const root = [...document.querySelectorAll('div[style*="vh"]')]
  .find(d => d.style.height?.includes('vh'));
const top = root.getBoundingClientRect().top + scrollY;
const range = root.getBoundingClientRect().height - innerHeight;

window.scrollTo(0, Math.round(top + p * range));  // keep ScrollTrigger in agreement
window.__orkestApplyProgress(p);
// A SYNTHETIC clock. `advance(performance.now())` in a tight loop passes ~the
// same timestamp 300 times, so a damped camera barely integrates and the frame
// is not the one you asked for.
let t = performance.now();
for (let i = 0; i < 300; i++) { t += 16.7; window.__orkestScene.advance(t); }
```

All of it is load-bearing. The real scroll must be set too, because taking a
screenshot forces a paint, which lets the ticker fire once and reset progress
from the actual scroll position. R3F will not initialise until something forces a
first paint, so **take a throwaway screenshot before the first `__orkestScene`
access**.

### Still unverified

- **Any real mobile viewport.** Chrome zooms rather than reflows when resized
  under automation here, so no breakpoint has been exercised. The composition
  rules compose for desktop aspects (1.6–2.4); a phone is a different frame and
  probably needs its own depth schedule. **The plate makes this sharper, not
  softer:** `desk-room.jpg` is 1.51 aspect, so a portrait phone crops it hard,
  and the hero-contrast numbers above were measured at 1600×776 only. The
  desk-edge anchoring is aspect-invariant by construction, but the wash and the
  copy's overlap with the dark bookcase are not — re-measure on a real device.
- **Motion in real time** at 60fps under a real scroll, and performance on
  integrated graphics. The plate adds one full-screen composited layer plus a
  blurred twin; both are static-`filter` and should be free, but that is reasoned
  rather than profiled.
- The floating nav pill overlaps cards in some frames. It reads acceptably but
  has not been designed around.
- **Whether the `loading` fallback is server-rendered.** Next 16's docs do not
  state whether `dynamic(..., { ssr: false })` renders its `loading` component
  during SSR. If it does, the plate is the LCP element and in the initial HTML;
  if not, this is still strictly better than the grey block it replaced. Not
  worth guessing at — check the served HTML if LCP ever needs the answer.

## Knowledge base UI (2026-08-16)

Build-plan days 8–9. `app/(dashboard)/knowledge/{page,[kbId]/page}.tsx`,
`components/knowledge/{kb-dialog,document-dropzone,document-list,chunk-inspector,
retrieval-playground}.tsx`, the pure vitest-covered `lib/knowledge.ts`, and
`knowledgeApi` in `lib/api.ts`. Verified in a browser in both themes.

- **`knowledgeApi.upload` MUST send `Content-Type: multipart/form-data`, and the
  reason is the opposite of the obvious one.** `apiClient` defaults every request
  to `application/json`; axios reads that header in `transformRequest` *before*
  the body, and on a JSON content type it runs `FormData` through
  `formDataToJSON()` — the `File` becomes `{}` and FastAPI answers 422 "Field
  required". Naming multipart only takes it off that path: axios strips the header
  again in `resolveConfig` so the browser writes the real one with a boundary.
  The old docstring said Content-Type was "deliberately not set", which is right
  for `fetch` and wrong for this instance. Every upload was broken until fixed.
- **Document status is polled, and the interval must stop.** `refetchInterval`
  returns 2500 only while `hasPendingDocuments()` (any `uploaded`/`processing`),
  false otherwise, so a settled corpus makes no background requests. Same
  decision and same reasoning as the Execution Viewer.
- **The playground searches with `score_floor: 0` on purpose** and renders the
  backend's 0.3 default as a dashed, dimmed "below cutoff" treatment instead. It
  exists to calibrate that threshold, so filtering by it first would mean tuning
  a number against results it had already removed. Do not "fix" the mismatch by
  passing the backend default.
- **Every query is billable and the cost is shown.** This is the screen people
  run dozens of queries on; hiding the per-query cost on a per-query-priced
  feature is how a demo turns into a surprise invoice.
- **The chunk inspector's selection is an ID, derived against the live list** —
  never a stored document object. Ingestion mutates the row under the selection
  and the row can be deleted outright; deriving makes both correct for free.
- **`knowledge_search` reaches the builder two ways and they are not symmetric.**
  Inline puts the KB picker on the node. Registry mode makes the KB, `top_k` and
  `score_floor` read-only off the row and leaves only `query`/`query_fields`
  editable — `NODE_OVERRIDABLE_KEYS`. A registry retrieval row **must carry a
  default `query`**: `_knowledge_search_config` refuses a config with neither
  `query` nor `query_fields`, so `tool-dialog.tsx` collects one and labels it as
  a default a node may override.
- **The type has no mutating switch in either surface**, and that is enforcement
  rather than tidiness: the backend rejects `is_mutating: true` on retrieval, so
  `tool-dialog.tsx` sends `canMutate && isMutating` (the switch keeps its state
  across a type change) and the inline form drops the flag when you switch to it.
- Verifying config-panel text fields under browser automation: **synthetic typing
  collapses to one character per burst.** Those values round-trip through the
  React Query cache, so the re-render lands a keystroke late and React rewinds the
  input to the stale value. ~300ms per character is correct; it affects every
  builder config field equally (the long-standing `url` field included), so it is
  an automation artefact, not a bug. Type slowly or assert on the row.

## Tools registry page (2026-08-12)

`app/(dashboard)/tools/page.tsx` + `components/tools/{tool-dialog,delete-tool-dialog}.tsx`,
consuming the `/api/v1/tools` CRUD that had been complete on the backend since
2026-08-08 and entirely unconsumed — the same shape as the integrations
endpoints before the Settings page. `toolsApi` is the sixth client in
`lib/api.ts`. No backend change was needed.

- **The dialog edits exactly the fields a node cannot override.** The registry
  owns the shape of the call (`url`/`method`/`headers`/`timeout_seconds`, or
  `action`) and the node owns the payload, so there is deliberately **no body
  editor here** — anything collected would be silently replaced by the first
  node that wired one up. That mirrors `ToolService.NODE_OVERRIDABLE_KEYS`
  exactly; if that set changes, this dialog changes with it.
- **`tool_type` is create-only.** `ToolUpdate` sets `extra="forbid"`, so sending
  it (or `workspace_id`) is a 422, not a silent no-op. The Select is disabled on
  edit and says why.
- **`input_schema` has no editor and PATCH omits the field.** Agent
  function-calling is deferred, so nothing reads it — and because the API uses
  `exclude_unset`, an existing value survives an edit here untouched. Add the
  editor when the ReAct loop lands, not before.
- **409 on delete is a permanent explained state**, rendered in the dialog
  rather than as a toast: the tool is referenced by a *published* version and
  retrying cannot change that. (Draft references deliberately do not block.)
  Delete is soft on the server — a hard delete would cascade to
  `tool_executions` and destroy the Vol. 4 §4.3 audit trail.
- **Workspace-scoped, like the Workflows list.** A tool's name is unique per
  workspace and a node can only reference tools in its own, so browsing across
  workspaces would show tools the workflow being built cannot use. The page and
  the builder share the query key `['tools', orgId, workspaceId, 'all']`.
- The `mutating` badge variant was added to `components/ui/badge.tsx` rather
  than forked — that cva is the status vocabulary. Amber, not red: registering a
  mutating tool is normal, and what the badge signals is that publishing will
  need an upstream approval node.

## Settings page (2026-08-08)

`app/(dashboard)/settings/page.tsx` + `components/settings/openai-key-card.tsx`,
wrapping the BYOK endpoints that had been complete on the backend since
2026-08-06 and entirely unconsumed. `integrationsApi` is the fifth client in
`lib/api.ts`.

- **404 is the empty state, not an error.** `GET /integrations/openai_api_key`
  returns 404 when no key is stored. The card renders "no key stored" for that
  and reserves `ErrorState` for real failures.
- **403 is a permanent, explained state.** `integration:read`/`integration:write`
  are Owner-only by design (a stored key is a direct billing-exposure lever), so
  a non-Owner gets a locked card, not a retryable error. Both 404 and 403 are
  excluded from React Query's retry.
- **`last_four` is the only view of the key that exists.** There is no code path
  on the server that decrypts and returns the raw value, even to the owning org
  — don't add a field expecting it to be filled in.
- Vol. 3 §10 specifies six admin pages; only Integrations has a backend. The
  other five are deliberately absent rather than stubbed.
