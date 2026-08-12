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
- **The run film's beat state is React; its progress bar is not.** One
  ScrollTrigger scrubs 0→1; `onUpdate` writes the continuous progress straight
  to the DOM and only calls `setState` when the discrete beat index actually
  changes. Putting the float into state re-renders the tree every scroll frame.
- **The film pins on desktop only.** Below `lg` the same trigger runs unpinned,
  because a pin fights a phone's collapsing address bar — every collapse is a
  resize, every resize re-measures the pin. With `prefers-reduced-motion` no
  trigger is created at all and the stepper buttons are the only control, which
  is why they are real `<button>`s.
- **The film is fiction that must stay technically true.** `lib/run-film.ts`
  uses real `WorkflowRun` statuses and its tests pin the load-bearing invariant:
  on the approval beat `approval_1` is `waiting` while `post_to_erp` is still
  `pending`. If that ever flips, the film is claiming the ERP was written to
  before a human approved — the exact opposite of the page's argument.
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
