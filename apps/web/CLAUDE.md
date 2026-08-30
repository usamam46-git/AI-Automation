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

## Design system — the Atomie language (2026-08-22)

The product surface (`app/(dashboard)/` and `app/(auth)/`) was redesigned onto
the "Atomie" language, sampled from the reference shots in
`public/{Sample,Sample1,Sample2,sample3}.webp`. Everything before this was
untouched shadcn: stock neutral tokens, white-card-on-white-page held apart by a
hairline, and no brand colour anywhere.

**Marketing is deliberately NOT in this scope.** `app/(marketing)/` keeps its
sky-and-lime palette, its system font stack and its own measured contrast. The
two palettes share exactly one thread — lime — and even that is a different hue
on each side. See "What protects marketing" below; it is load-bearing.

### The one idea: depth is a FILL STEP, not a border plus a shadow

A card sits one step away from the page and an inset sits one step further, in
both themes. This is the inverse of what the app did before and it is what makes
the language recognisable.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--background` | `#F7F7F4` | `#0B0B0B` | Page |
| `--card` | `#EFEFEC` | `#161616` | Card fill — **no border, no shadow** |
| `--surface-2` | `#E7E7E3` | `#1E1E1E` | Inset inside a card; segmented-control tracks |
| `--popover` | `#FFFFFF` | `#1E1E1E` | Dialogs, menus, tooltips — lifted *above* the page |
| `--foreground` | `#1A1A1A` | `#F2F2F0` | Ink |
| `--muted-foreground` | `#6B6B66` | `#8C8C88` | Secondary |
| `--border` | ink @ 7% | white @ 8% | Hairline. Separators INSIDE a card, and inputs |

Consequences, all of which have already caught something:

- **`border` on a `<Card>` is a bug.** If two cards need separating they need
  spacing, not a stroke.
- **A Card inside a Card is invisible** — both resolve to the same fill. Use the
  new `<CardInset>` (`components/ui/card.tsx`) for the inner one.
- **A floating surface goes the other way.** Popover fill plus `shadow-pop`, so
  it reads as above the page rather than as one more card lying on it. The
  builder's node chips are the one non-overlay exception and say why inline.
- **The true-black dark rule survives.** `#0B0B0B` is neutral, never shadcn's
  blue-tinted slate. Greys here must not be warm.

### Brand

```
--lime:      #C3E455   --primary, and the nav's active pill
--lime-deep: #A8CC33   button hover/press, focus ring
--lime-soft: #DCEFA0   .app-tile fills            (dark: lime @ 14%)
--lime-ink:  #3F4D0C   glyph on a lime tile, and the eyebrow slash in light
```

**Lime always carries INK, never white.** Lime sits at L .87 — white on it is
~1.4:1 and fails at every size, while ink measures **12.06:1**.
`--primary-foreground` is ink in BOTH themes for this reason; do not "fix" it to
follow the theme.

**One lime action per screen.** That is what makes the accent mean anything, and
it is why `<PageHeader>` takes a single `action` with everything else going to
`aside`. A row of three primary buttons is a row of three things none of which
is primary.

### The status vocabulary is now real tokens

Vol. 3 §5 always named `--color-status-*` and they had never existed;
`components/ui/badge.tsx`'s cva was standing in, with
`components/dashboard/stat-card.tsx` and `lib/node-catalog.ts` hand-mirroring it.
All three now read one set: `--status-{neutral,info,warn,ok,bad}` plus a `-soft`
fill for each.

- Chips are flat: tinted fill, **no border**, desaturated.
- **Nothing in the status set is lime.** Lime is the brand and marks the primary
  action; a lime `completed` chip puts two vocabularies on one screen saying
  different things in the same colour.
- **The `-soft` fills are tuned against the CARD, not against white.** The first
  pass used white-tuned values and every chip measured ~1.03:1 against `--card` —
  the tints were there in the source and invisible on screen. They now separate
  from both card and page at 1.08–1.17 while keeping their text at ≥5.9:1. If you
  retune one, check it on a card, not on the page.

### Measured contrast — re-measure if you touch a colour

Read through a 1×1 canvas, not by regexing `getComputedStyle`: it returns
`oklab()` here and naively parsing its numbers reads lightness as the red
channel, flattering every ratio by ~10%. (Same method and same trap as the
marketing hero — see that section.)

| | light | dark |
|---|---|---|
| ink on lime (primary button, nav pill) | 12.06 | 12.06 |
| ink on lime-deep (hover) | 9.41 | 9.41 |
| chips (neutral / info / warn / ok / bad) | 5.91–6.98 | 5.74–8.00 |
| lime-ink on lime-soft (`.app-tile`) | 7.42 | 7.42 |
| foreground on card | 15.11 | 16.14 |
| muted-foreground on card | 4.65 | 5.36 |
| eyebrow slash | 8.59 | 13.64 |

**The eyebrow slash is the one that already failed.** It was `--lime-deep`, which
measured **1.72:1** on the paper — a pale hue on a near-white page is invisible
however saturated it is. Light mode uses `--lime-ink`; dark uses the bright
`--lime`. Do not swap them back for symmetry.

### Shape, depth, type

- **`--radius: 0.75rem`** (was `0.625rem`). Cards `rounded-2xl` (~21px), list
  containers / inputs / selects `rounded-xl`, buttons and chips `rounded-lg`.
- **Two shadows only** — `shadow-soft` (a hover lift) and `shadow-pop` (genuinely
  floating). **Cards get neither.**
- **Type is Plus Jakarta Sans**, registered in `app/layout.tsx` and bound to
  `--font-sans` by `.app-root`. This **retires the old rule** that body copy stays
  on the system SF/Segoe stack: that stack is a neutral OS UI face and the
  reference is a geometric grotesk, and no amount of colour work bridges that.
  Jakarta over Poppins because a pure geometric falls apart at the 11–13px this
  app spends most of its pixels on. `JetBrains_Mono` is unchanged for node keys,
  cron expressions, run ids and anything quoted as a literal.
- **Density stays product-grade.** The reference is a case-study poster; this is a
  working tool. Rows went 12px → 16px, not to marketing whitespace.
- **Motion**: subtle only, 150–250ms ease-out, no springy overshoot. Unchanged.

### Signature elements

- **`.app-eyebrow`** — the `/ Dashboard` label. The slash is a `::before` so it can
  take the brand colour without a nested span at every call site, and so it never
  lands in the accessible name.
- **`.app-bloom`** — ambient lime in two page corners, on a `fixed` inert layer
  behind everything, painted over by the sidebar and the cards. **It shipped three
  times too strong first** (22% over a 60rem radius washed the whole top of the
  page green); it is now 13%/8% over 34rem, and 6%/4% in dark, where the same
  alpha reads as coloured haze rather than as light.
- **`.app-tile`** — the lime icon tile, the reference's recurring motif.
- **`components/ui/dot-arc.tsx`** + the pure, vitest-covered `lib/dot-arc.ts` — the
  dot-matrix arc from `Sample2.webp`. Its one consumer is the Success Rate stat
  card. **Bleeding it off the card corner was tried and the card's own
  `overflow-hidden` sliced it into an unreadable crescent**; it now occupies the
  icon tile's slot. `null` renders the empty track, which is the right picture for
  "nothing has finished yet" — the same distinction `formatSuccessRate` draws
  between null and 0.
- **Dashed edges on the builder canvas**, applied via `defaultEdgeOptions` in
  `builder-canvas.tsx` — NOT per-edge in `lib/graph-mapping.ts`, which round-trips
  the graph to and from the API and whose output is pinned by tests. Presentation
  must not leak into that module.

### What protects marketing — check this before editing tokens

Three separate guards, and all three are needed:

1. **`.mk-root` re-declares the full light token set**, as it always did.
2. **It now also pins `--radius: 0.625rem`** and re-declares `--surface-2`, the
   four `--lime-*` and all ten `--status-*` tokens. Marketing shares six
   primitives with the app (Input, Textarea, Select, Switch, Label, Accordion),
   and `.mk-root` lives inside `<html class="dark">` for a dark-system visitor —
   without these, an input on the landing page picks `.dark`'s surface off `:root`
   and renders a near-black field on white paper. **Any new token an app primitive
   references must be added here in the same commit.** `--lime` maps to the
   *marketing* lime (`--mk-lime`, `#b9d94a`), not the app's brighter one: the two
   are different hues on purpose and the landing page's contrast numbers were
   measured against its own.
3. **The font is scoped, not global.** `.app-root` rebinds `--font-sans`; `:root`
   still carries the system stack, which marketing body copy inherits.

Verified live under `<html class="dark">`: marketing resolves `--radius` to
`.625rem`, `--background` to white, `--lime` to `#b9d94a`, keeps the system font
stack, and has no horizontal overflow.

### Document scrollbar (unchanged, 2026-08-11)

Thin silver (`#c3c7cf`) floating pill in light, `white/18` in dark, driven by
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

## Page composition — `PageHeader` owns the title

`components/shared/page-header.tsx`. Before this, **the title was rendered twice
on every page**: the shell painted `<h1>{title}</h1>` from its nav table and then
each page painted its own `<h2>Workflows</h2>` two rows below it. The shell header
now carries only workspace / theme / account, and the page owns its heading —
which is also the only place that knows what its primary action is.

`components/shared/filter-tabs.tsx` is the segmented status filter, extracted from
Workflows, Executions and Tools, where the same markup had been pasted three times
and the Executions copy had already drifted. It is **not**
`components/ui/tabs.tsx`: that primitive is Radix `Tabs`, which owns panel
association and roving focus for tab PANELS, and this filters a list that stays
mounted — modelling it as tabs would promise `aria-controls` semantics nothing
here implements.

**The sidebar is grouped** (`Automate` / `Build` / `Govern`), with `previewItems`
still below a rule. Eight flat rows read as one undifferentiated list. The
`startsWith` active-match rule and its "distinct top-level segment" constraint are
unchanged — see the comment on `navGroups`.

**The shell is `h-screen overflow-hidden` and `main` is the scroll container.**
It was `min-h-screen` at first and that is a real bug, not a preference: a
container with a MINIMUM height grows to fit its content, so the document
scrolls instead of `main` and **the sidebar scrolls away with the page**.
Reported on `/agents` and `/audit-log`, the first pages tall enough to show it.
`main` and the `aside` both carry `.app-scroll`, which reapplies the silver-pill
scrollbar — moving the scroll off `<html>` also moved it off the styled
scrollbar rules, which are scoped to `html` on purpose. Verified: the document
does not scroll, `main.scrollTop` moves, and the aside stays at `top: 0`.

**The builder's full-bleed offsets track the shell and will break silently if it
moves.** `app/(dashboard)/workflows/[workflowId]/builder/page.tsx` uses
`-mx-4 -mb-10 h-[calc(100dvh-4rem)] md:-mx-6`, matching a `h-16` header and
`main`'s `px-4 pb-10 md:px-6`. Get these wrong and the canvas either scrolls the
page or leaves a band of paper under the minimap.

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
  ids are likewise derived (`source->target`), not persisted.
- **Renaming a node key is a whole-graph rewrite** (`lib/node-rename.ts`,
  2026-08-20). It was read-only until then, on the grounds that a rename means
  rewriting every referencing edge — which is exactly what `renameNodeKey` now
  does, in one pure function, along with every `node_outputs.<key>.<field>` path
  an author has typed into a node config or an edge condition. That second half
  is the load-bearing one: a path with a valid root and a dead second segment
  resolves to nothing at run time and is flagged by nothing, so a rename that
  moved only the node and its edges would silently break downstream mappings.
  Matching is on **segment boundaries** — `agent_1` must not rewrite
  `agent_10`, and `node_outputs.other.agent_1` is a field, not a reference.
  The panel commits on Enter/blur, never per keystroke (each commit rewrites the
  graph, so a half-typed key would be written into downstream paths), and
  selection follows the node to its new key.
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
  config, **category and search keywords**) is data in `lib/node-catalog.ts`,
  and one card component is registered for all seven types. Don't fork per-type
  components.
- There is no `trigger` node type. `NodeType` is
  `agent | tool | condition | human_approval | subgraph | start | end`;
  `trigger_type` is a field on the workflow shell.

### Left to right, the node picker and Tidy up (2026-08-28)

Phase 1 of the n8n-style builder work. The canvas now reads **left to right**,
there is no palette column, and nodes are added through a searchable picker.

- **Handles are `Position.Left` (target) / `Position.Right` (source).**
  `builder.css` carries the matching `.react-flow__handle-left/-right` offsets
  and they MUST track the component — changing one side alone leaves the dot
  sitting on the card's rounded border. The old `-top`/`-bottom` rules are gone.
- **`components/workflow-builder/node-palette.tsx` was deleted.** Adding a node
  is now: the ⊕ on an unconnected output handle, the ⊕ on an edge, dragging a
  connection onto empty canvas, or the toolbar's "Add node". All four open
  `components/workflow-builder/node-picker.tsx`.
- **The picker is positioned at a screen POINT, not anchored to a trigger.**
  Three of the four gestures have no element to anchor to (a drop point, a
  handle that unmounts, an edge midpoint under a transformed SVG), so it is a
  fixed-position panel with its own click-away backdrop rather than a Radix
  Popover with four virtual anchors.
- **`searchNodeCatalog` (pure, vitest) owns filtering AND ranking.** The
  ranking is not decoration: plain substring matching put Agent above Condition
  for the query "if", because "classify" contains it. An exact keyword hit now
  beats an accidental substring, and groups are ordered by their best match. A
  blank query scores everything equally and the stable sort preserves the
  documented category order.
- **The handle filters decide what a gesture may offer.** Adding off an output
  excludes `start` (no input handle — the promised edge could not exist);
  inserting into an edge additionally excludes `end`. Offering a type the
  gesture cannot connect would leave a fresh orphan and a validation error the
  user did not ask for.

**The ⊕ shows only on an output with NO outgoing edge.** This is n8n's rule and
it is also the only placement that works here. The button sits ~30px outside the
card, in the connector's lane; the seeded demo graphs space nodes 220px apart
with a 210px card, so on a connected node that lane is *inside the next card*.
React Flow gives every node wrapper an inline `z-index: 0`, so the later sibling
paints over the button and takes the hover — it could be neither seen nor
clicked. Observed in a browser, not theorised. `useHasOutgoing`
(`builder-actions-context.tsx`) supplies the flag.

Three more things that bit during that pass and are cheap to reintroduce:

- **The issue tooltip is `side="top"`, not `side="right"`.** The right edge is
  the ⊕'s lane, and a node with issues is exactly the node someone is about to
  extend — a right-side tooltip covered the button beside it.
- **A custom edge MUST forward `style` to `BaseEdge`.** The dashed stroke comes
  from `defaultEdgeOptions`; dropping `style` renders every connection solid and
  nothing errors.
- **`bg-surface-2` is invisible on a popover in dark.** `--surface-2`,
  `--popover` and `--accent` all resolve to `#1E1E1E`, so the picker's active
  row had no highlight. It uses `bg-foreground/8` instead — the same overlay
  technique `builder.css` already uses for the selection rectangle. Note this
  affects `components/ui/dropdown-menu.tsx` too (`focus:bg-surface-2`), which is
  a pre-existing app-wide issue and deliberately NOT changed here.

**Tidy up (`lib/graph-layout.ts`) is explicit and never automatic.** Auto-layout
on open would move every node, which autosave reads as an edit — on a published
version that silently creates a byte-identical version N+1, the exact bug the
autosave section already documents. `looksVertical()` exists to *suggest* a
tidy, never to perform one.

The layout is Sugiyama's three phases (layer / order / position) by hand rather
than dagre: these graphs are 5–15 nodes and already validated acyclic, so the
dependency is not warranted — the same call as WebGL-not-three.js. Two
properties the canvas depends on: it **terminates on a cyclic graph** (the
canvas holds invalid drafts constantly, and `cycle` is a publish-time rule), and
it is **deterministic**, or every Tidy up would be a fresh autosave. Long edges
get invisible dummy nodes so a skip edge routes AROUND the cards it passes; on
the invoice graph that is the difference between the approval gate sitting off
the spine and the bypass being drawn straight through the approval card.

**It frames the bounds it just computed, via `fitBounds` — not `fitView`.**
React Flow measures from its internal store, which still holds the pre-layout
positions on the next frame, so `fitView` (even inside a `requestAnimationFrame`)
framed where the graph used to be and left the tidied row jammed under the
toolbar. The positions are already known at that point; there is nothing to wait
for.

### The node detail view (2026-08-30)

Phases 2–4 of the n8n-style work. **`config-panel.tsx` is deleted.** Node
settings now live in a full-screen INPUT | PARAMETERS | OUTPUT overlay opened by
double-clicking a node. The 320px column could show what a node's settings were;
it could not show what data arrives, what leaves, or where a `node_outputs.…`
path comes from, and those are the three things a non-coder actually needs.

- **The parameter forms are the EXISTING ones, re-hosted unchanged.** They
  construct exactly the shapes `_agent_config` / `_tool_config` accept, and that
  contract is not something to re-derive while moving a panel. The
  `key={node.id}` remount is preserved: every row editor holds local draft state
  that must not carry between nodes.
- **`zoomOnDoubleClick` is off.** Double-click means "open this step"; React
  Flow's default fired on the pane, so a mis-aimed open jumped the canvas to 2×.
- **Escape inside the node-key field reverts the edit and does NOT close the
  dialog** — it stops propagation. The first press should undo the rename, not
  throw away the panel.
- **A condition node has real parameters for the first time.** Its NDV lists the
  outgoing edges as a routing-rules table — n8n's Switch node, mapped onto the
  existing per-edge model with no schema change. Rules render in **evaluation
  order** (`lib/condition-rules.ts` mirrors the backend's
  `_ordered_condition_edges`); routing is first-match-wins, so any other order
  would actively mislead.
  **It warns when two branches both carry a rule**, and that warning is not
  padding: the backend sorts by `(is_catch_all, created_at, id)`, and
  `save_draft` re-inserts every edge in ONE transaction, so `created_at` ties
  across the whole graph and the tiebreak falls through to a random UUID. Only
  "the fallback runs last" is guaranteed. The classic ladder — `> 1000` then
  `> 100` — is therefore unsafe here, and nothing else in the product says so.
- **The Start node holds a sample trigger payload** under
  `config.sample_payload`. The backend **ignores** the key (node `config` is
  free-form JSONB with no `extra="forbid"`; `start_handler` returns `{}`), and it
  exists so the builder can show and drag the fields every downstream node
  addresses as `trigger_payload.*`. It is also what a Test step sends. If that
  key ever has to mean something server-side, this is the note to find first.

`lib/data-preview.ts` and `lib/node-output-shape.ts` are the pure modules under
all of it.

- **`node-output-shape.ts` MIRRORS `node_handlers.py`** and must change with it.
  Each shape is a handler's literal return value; the header table is the full
  list. Easiest to get wrong: `http_request` is `{status_code, body}` and
  **never echoes headers**; `notify` is always `queued`, **never `delivered`**;
  an agent's shape comes from its own `output_schema.properties`, with
  optionality read as a nullable type because strict mode makes every declared
  property required.
  **`start` is not rooted at `node_outputs`** — a start node writes nothing, and
  what downstream nodes read from it is `trigger_payload`.
  **`inputSourcesFor` walks THROUGH condition nodes**, which execute never and
  write nothing; otherwise a node behind one gets a permanently empty input panel
  while the data it reads sits a step further back.
- **`data-preview.ts` path construction mirrors `resolve_field_path`.** Arrays
  are addressed by **integer index** (`hits.0.content`), and **a key containing a
  dot is permanently unreachable** because the resolver splits the whole path on
  "." — those nodes are marked `addressable: false` so the UI refuses to offer a
  path that would silently resolve to null, and unaddressability is **inherited**.
  `toTable` takes the **union** of keys across rows, or a field only some items
  carry would vanish.

### Drag-and-drop field mapping (2026-08-30)

**What a drop writes is a dotted state PATH, never an expression.** n8n drops
`{{ $json.foo }}` into a template string; this product has no template language
and no `eval` anywhere, so the config the forms emit is byte-identical to what it
was before anyone dragged anything.

- `lib/field-drag.ts` owns the payload and the drop rules, so they are asserted
  rather than click-tested. A dropped path never overwrites an existing mapping —
  the suggested key is de-duplicated (`vendor`, `vendor_2`). An array index is
  skipped when suggesting a key, because `0` is a useless field name.
- **The picker is the primary implementation and drag is a shortcut onto it.**
  Drag is mouse-only, and a builder whose central act is unreachable by keyboard
  is not finished. Both routes call one `onChange`.
- **Drop-to-append is handled inside `KeyValueEditor`/`StringListEditor`, not in
  their wrappers.** Those editors read `value` only on mount (local draft rows —
  a controlled map would drop a row the moment its key is blank), so appending
  from outside would not appear until the editor remounted.
- **`PathInput` is where path checking finally lives.** The old check looked at
  the FIRST SEGMENT against a hardcoded list; `lib/state-path.ts` also knows
  whether the step named exists and **whether it runs before this one**. A
  forward reference is syntactically perfect, resolves to null every run, and is
  reported by nothing else — it is the single most valuable check here. All of it
  is **advisory**: the server stays the authority on what may publish.
- `STATE_ROOTS` moved from `field-map-editor.tsx` to `lib/state-path.ts`, so the
  pure check and the component rendering it do not each own a copy.

### The live run on the canvas (2026-08-30)

Running a workflow used to navigate to `/executions/{id}` — the right page for
auditing a past run, the wrong one for authoring, since you lose the graph at
exactly the moment its behaviour becomes observable. It now stays put.

- **Run state reaches node cards through `RunOverlayContext`, never through
  `node.data`.** `data` is the autosave payload; a status pill written there
  would be saved as part of the graph. Same rule as `IssueContext`.
- **"running" is INFERRED and says so.** The engine streams with
  `stream_mode="updates"`, which yields a chunk only once a node has finished, so
  no node can be announced as it starts. `current_node_key` names the node that
  most recently COMPLETED; a successor of it with no row yet is shown as running,
  and `NodeRun.inferred` carries that caveat rather than hiding it.
- **"which branch was taken" is inferred too** — nothing records the routing
  decision. An edge is marked taken when both ends have executed. On a converging
  graph that can credit two incoming edges when one fired; it never invents a
  path to a node that did not run.
- **The overlay polls `GET /executions/{id}/status`**, which carries no
  input/output blobs, on its own `["builder-run", runId]` key. Writing run state
  into the builder's cache entry would corrupt the open canvas. The NDV fetches
  the ONE open node's full row separately, and indexes
  `output.node_outputs[nodeKey]` — that channel holds the accumulated map for the
  whole run, so showing it raw would put every node's state on every node's panel.
- **`nodeDurationMs` prefers `completed_at - started_at`** (the handler's own
  wall clock) and falls back to `latency_ms`, which is a whole-superstep delta
  shared by every node in the step.
- **The node card hides cost where it does not exist.** `http_request`,
  `erp_connector` and `notify` spend no LLM money and leave `cost_usd` NULL;
  rendering "$0.00" would claim a measurement that was never taken.
- **"Test run" and "Test step" both call the test-run endpoint on the version on
  screen.** The old button called `triggerRun`, which is pinned to
  `current_version_id` — so on a draft it ran the PUBLISHED graph and reported
  success. The toolbar tooltip no longer says "publish a version first", because
  that is no longer true.

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
`graph-validation`, `graph-mapping`, `output-schema`, and as of 2026-08-28
`graph-layout` (23), `node-catalog` (24, over `searchNodeCatalog`'s filtering and
ranking), `data-preview` (25), `node-output-shape` (30), `condition-rules` (19),
`field-drag` (17), `state-path` (17) and `run-overlay` (25). Canvas drag/drop,
panel rendering and React Flow theming are deliberately uncovered; they are
verified manually in the browser.

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
  workflow-shell ones, deliberately. **The `--color-status-*` tokens Vol. 3 §5
  names now DO exist** (Atomie pass, 2026-08-22) — this used to say they did not
  and that the cva was standing in for them. The cva is still where the
  vocabulary is *named*; the colours come from the tokens. Extend the cva rather
  than forking a parallel set, and add a token only if a genuinely new state
  needs one.
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
- Stat-card accents read the `--color-status-*` tokens directly (Atomie pass,
  2026-08-22). They used to be Tailwind palette classes hand-mirroring
  `badge.tsx`'s run statuses, with their own `dark:` twins — three copies of one
  vocabulary that had to be kept in step by hand. `accent="brand"` is the fourth
  option and is NOT a status: it is the lime `.app-tile`, for the card on the row
  that is a headline rather than a condition.

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

## Smooth scroll — Lenis owns the marketing scroll (2026-08-30)

`lib/smooth-scroll.ts` (pure, vitest-covered), `components/marketing/smooth-scroll.tsx`,
wrapped around the subtree in `app/(marketing)/layout.tsx`. One new dependency,
`lenis`, plus `@import "lenis/dist/lenis.css"` in `globals.css`.

The scene's choreography was fine; the **driver** was raw. One
`ScrollTrigger.create({ scrub: true })` mapped native scroll straight onto scene
progress, and native scroll is not continuous — a wheel notch is a ~100px jump.
So the camera (damped by `CameraRig`) glided while the plate transform, the
backdrop gradient, hero opacity and every document position snapped. Lenis
interpolates the input instead: GSAP's ticker drives `lenis.raf`, ScrollTrigger
reads the smoothed position, and **nothing in `lib/scene-script.ts` changed** —
progress still arrives as a 0-1 float, so every composition rule, projection
test and contrast measurement holds.

Five rules, in the order they will bite someone:

- **`ScrollTrigger.normalizeScroll()` must never be enabled.** It and Lenis both
  take ownership of the scroll position. `lib/gsap.ts` has never called it and
  now says so; `ScrollTrigger.config({ ignoreMobileResize: true })` is a
  different thing and stays.
- **`scrub` stays boolean.** Lenis is the smoothing layer now, so a numeric
  `scrub` would smooth an already-smoothed signal and read as lag, not weight.
- **Any new in-page jump goes through `lenis.scrollTo`**, never
  `scrollIntoView({ behavior: "smooth" })` and never `scroll-behavior: smooth` —
  the browser's animation and Lenis's fight over the same position. Ordinary
  `<a href="#…">` links need no change: `anchors: true` intercepts them, which
  covers `mk-nav.tsx`, `faq.tsx`, `mk-footer.tsx` and the layout's skip link.
  The hero's "Watch a run" is the one non-anchor jump and calls `scrollTo`
  directly, with `offset: 0` mirroring the marker's explicit `scrollMarginTop: 0`.
- **The GSAP wiring lives in a CHILD component using `useLenis()`, never in a
  `ref` on `<ReactLenis>`.** This shipped wrong once and the symptom is worth
  recognising: **the mouse wheel did nothing at all while the scrollbar and the
  arrow keys worked fine.** `ReactLenis` holds its instance in `useState` and
  creates it in its own effect, exposing it via `useImperativeHandle(..., [lenis])`
  — so on the first commit the ref's `lenis` is `undefined`, and the `setLenis`
  that follows re-renders `ReactLenis`, **not its parent**. A parent effect reads
  `undefined`, bails, and never runs again. Lenis's own wheel listener attaches
  regardless and calls `preventDefault`, so the wheel is swallowed while `raf` is
  never driven; the scrollbar and keyboard set the native scroll position
  directly, bypass the virtual scroll, and keep working. That asymmetry makes a
  dead animation loop read as a wheel-specific bug.
- **`SmoothScroll` is always mounted, never conditionally rendered.**
  `usePrefersReducedMotion()` returns `false` on the first client render and then
  settles, so gating the component on it would unmount and remount the whole
  marketing subtree — WebGL canvas included — on that settle. Reduced motion is
  expressed through the *options* (`smoothWheel: false`, `anchors: { immediate: true }`).
- **`autoRaf: false` and `syncTouch: false` are pinned by tests, not by taste.**
  A second raf loop desynchronises Lenis from `ScrollTrigger.update`, which runs
  on the same ticker; `syncTouch` fights iOS momentum and is the usual source of
  "laggy on mobile" with this library. `lerp: 0.1` is the feel knob and is
  Lenis's own default.

Window mode, no `wrapper`, so it animates the **real** scroll position — the
sticky stage, the 420vh container and `sceneAnchorTopVh`'s absolute `vh` offset
are all untouched. Do not reach for a transform-based wrapper.

`html.lenis { height: auto }` (specificity 0,1,1) overrides the `h-full` on
`<html>` from `app/layout.tsx` (0,1,0) while an instance is live. That is Lenis's
intent, verified benign: at the page bottom the footer sits flush and html/body
resolve to the content height.

### Verifying this — and why the first check missed a dead page

**`window.__orkestScroll` is the handle** (dev only, the `__orkestApplyProgress`
precedent): `{ lenis, tick }`, where `tick()` forces one GSAP ticker frame.

This is not convenience, it is the only way to see anything. Browser automation
runs this page with `document.visibilityState === "hidden"` permanently, where
`requestAnimationFrame` fires **zero** times per second — measured directly, not
assumed. GSAP's ticker is therefore frozen, `lenis.raf` never runs, and **no**
animated scroll of any kind is observable: not Lenis's, not
`scrollIntoView({ behavior: "smooth" })`, not a GSAP tween.

**That is exactly how the ref bug above survived a browser check.** A queued
`scrollTo` that never moves looks identical to a broken one, and every symptom of
the dead loop — wheel swallowed, page motionless — was written off as the known
frozen-rAF artifact. The page shipped unscrollable by wheel. Anchor clicks
appeared to work only because the **browser's own hash jump** did them.

So: never conclude the smoothing works from a page that merely renders. Drive the
ticker and read positions.

```js
const h = window.__orkestScroll;
h.lenis.scrollTo(0, { immediate: true });
dispatchEvent(new WheelEvent('wheel', { deltaY: 600, cancelable: true }));
for (let i = 0; i < 26; i++) {
  await new Promise(r => setTimeout(r, 16));   // real elapsed time per tick
  h.tick();
  console.log(Math.round(scrollY));
}
```

**The `setTimeout(16)` is load-bearing.** Lenis damps against real elapsed time,
so back-to-back `tick()` calls pass a ~0ms delta and the page crawls a few pixels
— which looks like the same failure again. With real time between ticks the
output is the lerp curve: 26 distinct positions easing 68 → 588 toward a 600
target. Anything that lands in one step, or does not move, is a broken chain.
For the same reason the **first** tick after a pause over-integrates and jumps;
ignore it. Keep loops under ~30 iterations or the CDP call times out at 45s.

Confirmed this way after the fix: bridge mounted, `wheelPrevented: true`,
`targetScroll` set, scrollY easing across 26 distinct positions, scene progress
tracking it, and a real 3-tick wheel gesture landing mid-transition. Also
verified: Lenis intercepts the wheel on `/` and **not** on `/login` (no `lenis`
classes there, `<html>` back to 936px) — that pair is the proof the scoping
works; `position: sticky` still resolves; `#how-it-works` lands at progress
**0.5202** against the run scene's 0.52, matching the figure recorded on
2026-08-18, from both the nav anchor and the hero button's `lenis.scrollTo`; no
horizontal overflow; footer flush at the bottom.

**Still unverified:** the *feel* at 60fps under a real hand on a real wheel
(nobody has scrolled this outside the tick harness), the reduced-motion path in a
browser (the pure function is tested, the media query was never toggled), and
**any real phone** — touch is deliberately left on the browser's own momentum so
this change cannot regress mobile.

One consequence to keep in mind: because Lenis preventDefaults the wheel, wheel
scrolling now **depends on the ticker**. GSAP wakes it on `visibilitychange` so a
backgrounded tab recovers, and the scrollbar and keyboard bypass Lenis entirely
so the page is never fully stuck — but anything that kills the ticker for good
now costs the wheel, not just the animation.

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

## Approval sentence + trigger payload (2026-08-17)

Build-plan days 10–12, frontend half. Two pure vitest-covered modules —
`lib/approval-summary.ts` and `lib/trigger-payload.ts` — plus
`components/workflows/run-workflow-dialog.tsx` and a rewritten approval bar.

- **The approval sentence is DERIVED, and that is a settled decision, not a
  workaround.** Vol. 3 §6.1 shows "Approve $4,200.00 to Acme Vendor LLC?";
  `interrupt_payload` is `{type, node_outputs}` with no message string, and a
  `human_approval` node has no config to template one from. The 15-day plan §4
  settles approval copy as a frontend concern. `buildApprovalSummary` reads only
  what the workflow produced. **This is not licence to add a message-template
  field to `human_approval`** — that contract deliberately has none.
- **The one rule in `approval-summary.ts` is: never invent.** No default
  currency, no `0` for a missing amount, no summing of line items. If an amount
  cannot be read, the bar falls back to the generic headline and the raw JSON,
  which is what shipped before and is always honest. This is the single line a
  reviewer reads before authorising a write to a real system.
- **Field lookup is a convention, not a schema**, because agent output schemas
  are authored on a canvas and this module cannot know them. Adding a name to
  `AMOUNT_KEYS` / `PARTY_KEYS` / … is cheap and safe. **Reordering one is not**:
  first match wins, so moving `amount` above `total_amount` shows the wrong
  figure on a workflow emitting both. Node outputs are walked in insertion order,
  which is execution order, so an earlier node's value wins — "what was
  extracted" over "what was recomputed".
- **The raw node outputs stay on screen under the summary.** Not redundancy: the
  summary is a convention a workflow is free not to follow, so the evidence it
  was drawn from must always be visible.
- `formatApprovalAmount` hardcodes `$` and the grouping, and prints an unknown
  currency code rather than dropping it — dropping it turns a euro invoice into a
  dollar one. Same `toLocaleString(style: "currency")` trap already documented for
  `formatMonthlyCost` and NumberFlow; three formatters disagreeing on one screen
  is worse than any one being slightly off. Always 2dp, unlike `formatCost`'s 4dp
  branch, which exists for per-run costs of fractions of a cent.
- **`useTriggerRun` takes an object, not a bare workflow id.** It was a string
  until the Run dialog landed. React Query passes exactly one value to
  `mutationFn`, and a tuple would make every call site an anonymous pair. The
  Builder's Test Run is *not* a consumer — it has its own `useMutation`.
- **Blank payload input is valid and means `{}`**, byte-identical to every
  Run-now click before the dialog existed. The demo's HR assistant is meant to
  run on one click; a dialog demanding JSON first would take that away.
- **The dialog does not validate the payload against the workflow**, because
  there is nothing to validate against — a trigger payload has no schema
  anywhere. It only rejects what FastAPI would: a non-object top level.
- **The form is a child component so closing the dialog UNMOUNTS it.** Radix
  removes `DialogContent` from the tree when closed, so the reset is free; a
  `setRaw("")` inside an effect keyed on `open` is a cascading render and
  `react-hooks/set-state-in-effect` rejects it. The `key={workflow.id}` covers
  the one case unmount does not: switching workflows while the dialog is already
  open, where a payload typed for one would otherwise be submitted against
  another.
- `WorkflowDetailDialog` closes itself and calls `onRun` rather than opening the
  run dialog inside itself — two stacked Radix dialogs fight over focus trapping
  and the textarea ends up unfocusable. The page owns the single dialog.

## Audit log viewer (2026-08-18)

`/audit-log`, `components/audit-log/audit-log-row.tsx`, pure `lib/audit-log.ts`.
Consumes `GET /api/v1/audit-logs`, complete and unconsumed since 2026-08-09 —
the same shape the integrations endpoints were in before the Settings page.

- **It does NOT poll, and that is the point.** Every other list here polls
  because a run's status changes underneath the reader. An audit row physically
  cannot change (Postgres rejects UPDATE and DELETE on that table), so the only
  thing a poll could surface is a *new* row — and a trail that reorders itself
  while an auditor is mid-read is worse than one they refresh deliberately.
- **A 403 is a state, not an error.** `audit:read` is Owner/Admin only and sits
  in the backend's `WILDCARD_READ_EXEMPT`, so Viewer's `"*:read"` does not reach
  it. The locked card mirrors `settings/openai-key-card.tsx`, and the query's
  `retry` predicate skips retrying a 403 so the state renders immediately.
  The nav entry is shown to everyone: the JWT carries `sub`/`user_id`/`org_id`
  and no role claim, so hiding it would need a backend change.
- **`auditSummary` must never invent a fact** — the same rule
  `approval-summary.ts` follows. Every branch reads keys that the corresponding
  `AuditService.record()` call site actually writes, type-checks them, and
  returns `null` when it cannot. The caller then renders *nothing*, not a
  placeholder. A plausible sentence assembled from a guess is worse on an audit
  trail than no sentence, and the tests assert null for every action under both
  missing and wrong-shaped metadata.
- **`AUDIT_ACTION_META` must stay in step with the backend's `AuditAction`.**
  Both sides make the same promise — only actions something really writes are
  listed — and a test asserts `AUDIT_ACTIONS` and `AUDIT_ACTION_META` have
  identical keys. An unknown action still renders via `humanizeAction`, because
  the backend vocabulary is open by design (Vol. 2 §3.5) and a governance screen
  that blanks on a new action is worse than one with an awkward label.
- **The cursor is passed through verbatim.** `nextAuditCursor` returns the last
  row's raw ISO `created_at`; a round-trip through JS `Date` truncates to
  milliseconds and the backend compares `created_at < cursor`, so the boundary
  row would be re-served on every page. Same convention as Workflows/Executions.
- Five `member.*` actions joined the vocabulary on 2026-08-18. The test that
  used `member.invited` as its example of an *unknown* action caught the change
  and had to be repointed — that is the keys-in-step assertion working.
- Rows expand to the **verbatim `metadata` JSON** plus the full ids the
  collapsed row abbreviates. On a governance screen the underlying record is the
  product; the next question after "what happened" is "show me what you stored".

## The `#how-it-works` anchor (fixed 2026-08-18)

The nav, the footer and the hero's "Watch a run" button all target
`#how-it-works`. It matched **nothing** between 2026-08-13 — when the 3D scene
replaced `run-film.tsx` and deleted the section owning that id — and 2026-08-18.
Three silent no-ops.

Putting the id on the scene root does not fix it: that is progress 0, the hero
the reader is already looking at. What both links mean is the `run` scene, which
is a scroll **position**, not an element.

`sceneAnchorTopVh(sceneId, scrollVh)` in `lib/scene-script.ts` converts one to
the other. The scrub is `start: "top top"` / `end: "bottom bottom"`, so progress
`p` is reached at `scrollY = rootTop + p × (rootHeight − viewportHeight)`, and an
element at absolute `top: T` aligns to the viewport top at `rootTop + T` —
hence `T = p × (scrollVh − 100)` vh. `core-scene.tsx` renders a zero-height
`aria-hidden` div there.

Two consequences worth keeping: it is **pure CSS**, so native hash navigation,
`scrollIntoView` and a cold load with the hash already in the URL all work with
no listener; and it is **derived from `SCENES`**, so retiming the run cannot
leave "Watch a run" pointing at the wrong moment. Verified live — the nav link
landed at scrub progress 0.5200 against the run scene's 0.52 start, rendering
its first beat.

## Members + invitations (2026-08-18)

`components/settings/{members-card,invite-member-dialog}.tsx`,
`app/(auth)/accept-invite/page.tsx`, pure `lib/members.ts`, `membersApi`.
Backend contracts are in apps/api/CLAUDE.md's members section.

- **The predicates in `lib/members.ts` are an AFFORDANCE, not a boundary.**
  Every rule they encode — last active Owner, no self-edit, revoke rather than
  suspend a pending invite — is enforced by `MemberService` and 409s there. This
  copy exists so a refused action is disabled with a reason instead of failing
  after a click. If the two disagree the backend wins and the user gets a toast;
  that is degraded, not unsafe. **Never move a rule out of the service.**
- **`isSelf` compares MEMBERSHIP ids, not user ids.** A pending invitation has
  `user_id: null`, so a user_id comparison matches every pending row against
  every other one. For the same reason, never key a list on `user_id`.
- **`hasPermission` deliberately does NOT duplicate `WILDCARD_READ_EXEMPT`.** It
  is only ever asked about `member:*`, none of which are exempt; a partial copy
  of that set is a lie that drifts. Ask the backend about anything else.
- **The invite dialog's second state is the whole point.** There is no email
  delivery (`worker_notifications` boots with an empty registry), so the accept
  URL is returned in the response body and handed over on screen. Closing
  without copying makes the invitation unreachable until it is revoked and
  reissued — hence the explicit warning and a close button that says so.
- **`/accept-invite` runs its own silent session bootstrap.** Access tokens live
  in memory only, so someone already signed in who opens the link from their
  email arrives with an empty store and would be shown the *register* form —
  which can only fail for them with "Email already registered". `AuthGate`
  cannot be reused: it redirects to /login when there is no session, and this
  page must also work for someone with no account at all. So it attempts
  `authApi.refresh()` once and treats failure as a normal outcome that reveals
  the register form. Found in a browser, not in review.
- `RegisterPayload.organization_name` is now **optional** — the backend requires
  it only when `invite_token` is absent, and 422s when neither is present.

## Permissions UI + animated nav icons (2026-08-18)

`lib/permissions.ts` (pure), `components/settings/{role-permissions,
change-role-dialog,roles-matrix-card}.tsx`, `components/ui/animated-icons/`.

- **The frontend no longer resolves wildcards at all.** `roles.permissions`
  stores `["*"]` / `["*:read"]`, and expanding those needs the full vocabulary
  AND `WILDCARD_READ_EXEMPT`. The backend now returns `effective_permissions`
  (see `expand_permissions`), so `hasPermission` is a plain `.includes()` and
  the duplicated wildcard branch in `lib/members.ts` was **deleted**. If you
  write `endsWith(":read")` anywhere in `lib/permissions.ts`, stop.
- **Withheld capabilities are rendered, not just granted ones.** "Editor can
  build workflows" answers half of what someone assigning a role is asking; the
  other half is "and what can't they do?", which a list of ticks cannot answer.
  The contrast is the information.
- **`Make Admin` / `Make Viewer` menu items were replaced by one
  `Change role…`** opening a dialog with a gained/lost diff. Those items were
  one unexplained click from changing what a colleague can do to production
  workflows. The dialog resets per member via a **`key` prop**, not an effect —
  a synchronous setState in an effect is a cascading render and the lint rule
  correctly refuses it.
- `RolesMatrixCard` is Vol. 3 §10's "Roles & Permissions" page, **read-only**.
  The blueprint specifies a custom-role builder for enterprise; nothing writes
  an org-owned `roles` row, so this renders the same matrix as a reference
  rather than an editor. It makes the backend's subtle rules visible — Viewer
  holds `*:read` and still has no audit-trail tick, which is
  `WILDCARD_READ_EXEMPT` on screen.

### Icons

- **Glyphs are literal, not decorative.** `workflow.published` used to be a
  rocket; publishing here is an immutable version being cut, and a launch glyph
  oversells it in a way that reads as stock-AI dressing. It is
  `GitCommitVertical` now, and `webhook_secret.rotated` is a rotation rather
  than a second key. If a glyph could sit on any product's screen unchanged, it
  is the wrong glyph.
- **`components/ui/animated-icons/` is hand-built on the `motion` already in
  the tree** — the pqoqubbw/icons *pattern*, not the dependency. No new package,
  and identical Lucide geometry so they are indistinguishable at rest. Three
  rules, in that file's header: nothing moves unprompted (hover/focus only,
  driven by the parent `NavLink`), `prefers-reduced-motion` disables it
  entirely, and each animation moves the part of the glyph that carries its
  meaning. Uniform bouncing would be the animated equivalent of a rocket emoji.
- **The animation itself is UNVERIFIED under browser automation** — the tab is
  never focused, so neither `:hover` nor programmatic `.focus()` reaches React's
  delegated handlers, exactly like the frozen rAF documented for the 3D scene.
  Rendering at rest, the icon count and a clean console are all confirmed;
  the motion needs a human pointer.

## Mobile — what was actually wrong (2026-08-19)

The landing page was reported as "nothing aligned" on an iPhone 15 Pro. Verified
at a true 393×852 viewport and fixed. Two separate things, and the first one
mattered far more than it looks.

### One missing utility made the whole page look broken

`components/marketing/platform-tiles.tsx` holds an audit tile containing a
`CREATE TRIGGER` snippet whose **min-content width is 426px**. A CSS grid item
defaults to `min-width: auto`, meaning it refuses to shrink below its content —
so on a 393px phone that single tile forced the grid to 474px, which made
`document.scrollWidth` **494px against a 393px viewport**.

That is why *every* section looked misaligned: with the document 100px wider
than the screen, every centred `mx-auto` block is centred on 494 and reads as
shifted and clipped. One utility, sitewide symptom. The grid now carries
`[&>article]:min-w-0`; the snippet already had `overflow-x-auto`, which is what
this lets take effect. Desktop is unaffected — verified at 1440×900, tiles still
376/376/376/764 with no internal scrolling.

**The lesson worth keeping:** when a phone layout looks globally wrong, measure
`document.documentElement.scrollWidth` against `window.innerWidth` first. A
single unshrinkable grid or flex child explains a page-wide symptom far more
often than a dozen local mistakes do.

### The camera was looking through a slot

A perspective camera's *vertical* FOV is fixed, so horizontal extent is
`tan(fov/2) × aspect`. Going from a 2.0 desktop frame to a 0.46 portrait phone
cuts the horizontal view more than fourfold — every card composed away from
centre simply leaves the frame. `fovForAspect(aspect, progress)` in
`lib/scene-script.ts` compensates. Two guards make it safe:

- **At or above `REFERENCE_ASPECT` (1.6) it returns the authored 46° for every
  progress**, so no desktop frame can change.
- **It ramps in with `platePresenceAtProgress`**, so it is a no-op while the
  photographed room is on screen. The camera is *solved* against that photo;
  widening there would slide the paper off the wood, which six existing tests
  exist to prevent. They still pass.

Clamped at 82°: full compensation wants ~112°, which bows the desk edges and
balloons the nearest card. Beyond the clamp a phone simply shows a tighter crop,
which is the honest trade — a portrait frame cannot hold a 2:1 composition.

`camera` and `size` are read from the `useFrame` state, not `useThree()`: the
FOV write mutates the camera and the React Compiler correctly rejects mutating a
hook's return value.

### The automation ceiling — read this before trying to verify the scene

**`ResizeObserver` never fires in this browser-automation context.** Confirmed
directly: observing a correctly-sized element produced no callback in 2.5s, when
the spec requires an immediate initial one. R3F sizes its canvas from that
observer, so the canvas stays at its intrinsic **300×150** and the scene renders
nothing — at every viewport, top-level as well as in an iframe.

So a blank or tiny canvas under automation is **not** evidence of a bug, and the
older "frozen rAF" note is the same family of problem. **The 3D scene's
appearance cannot be verified here at all** — only its layout box. The FOV fix
above is unit-tested and provably inert on desktop, but nobody has seen it.

### The harness that does work

Window resizing is clamped by the OS (~494px minimum, and requests above the
display size are ignored), so drive layout tests through a **same-origin iframe**
— CSS media queries and `window.innerWidth` resolve against the frame, giving an
exact 393×852. Scale it visually with `transform: scale()` to fit the capture
region; a transform does not change an iframe's layout viewport.

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

## Signed-out surface — the split auth screens (2026-08-23)

`app/(auth)/layout.tsx` is a two-column split: form left, photograph right. It
was a single centred card before, which read as a scaffold — the landing page
opens on a photographed room and sells hard, and the first thing after "Get
started" was an unadorned box. The login/register pages consequently **dropped
their `<Card>` chrome**: a card inside a framed column is a second box for no
reason. `/accept-invite` inherits the same layout and still renders its own card,
which is correct — it is a decision surface, not a bare form.

- **The photograph is the app's only remote image.** `next.config.ts` gained
  `remotePatterns` narrowed to `images.unsplash.com` and the `/photo-**` path, so
  the allowance cannot quietly widen into "any URL a component feels like
  rendering".
- **`priority` is DEPRECATED in Next 16** (`next/dist/docs/01-app/03-api-reference/
  02-components/image.md`), which points at `loading="eager"` / `fetchPriority="high"`
  instead. Same rule the 3D scene's room plate already follows. It earns eager
  loading here — on a two-element page it IS the LCP candidate — and below `lg`
  the panel is not rendered at all, so a phone never pays for it.
- **The panel is its own dark surface in BOTH themes.** Verified live under
  `.dark` and light. The scrim fixes contrast independently of the viewer's
  theme, so there is no `dark:` variant to keep in step and no light-mode
  combination where white type lands on a bright patch of glass.
- **The contrast was measured, and one line failed.** The method is a canvas
  composite of the same layers (photo → `neutral-950/55` wash → the gradient),
  sampling the worst pixel under each line's box **with that line's own text
  alpha applied** — measuring against pure white flatters every translucent line
  and would have hidden the failure. The photo credit at `text-white/40`
  measured **3.82:1** against a needed 4.5; it is `/55` (6.09:1) now. That is the
  translucent-ink ceiling already documented for the marketing hero, and the
  reason to measure: it looks like a deliberately quiet caption at either value.
  The full table is in the layout's own docstring. Re-measure if the photograph
  or either scrim changes.
- **The photographer is not named, deliberately.** Unsplash's licence does not
  require attribution and crediting by name is the decent version of it, but
  unsplash.com sits behind a bot wall returning 401 to any automated fetch, so
  the name could not be verified — and inventing a plausible one under a
  photograph is worse than a generic credit. The source id is in a comment; fill
  it in if you know it.
- **The panel's claim is the product's actual guarantee**, the one
  `validate_mutating_approval` enforces at publish. Not a slogan about AI: a
  visitor who reads it and then uses the product finds the same sentence true.

## Tool dialog — the fields the 2026-08-23 backend work added

`components/tools/tool-dialog.tsx` grew four sections. Backend contracts are in
apps/api/CLAUDE.md's `http_request` section; what matters here:

- **Secrets are write-only and the editor cannot pre-fill them.** The API returns
  `secret_keys`, never a value. So an existing tool shows its stored names and a
  warning that adding a row **replaces the whole set** — because PATCH does. The
  dialog tracks `secretsTouched` and omits `secrets` from the payload entirely
  unless the author edited it; without that, an unrelated rename would wipe every
  credential the tool has.
- **The headers placeholder is now `Bearer {{secrets.erp_token}}`**, and the help
  text says config is plaintext and API-visible. That is the whole point of the
  change — a credential typed directly into a header still works and is still
  wrong.
- **The idempotency switch only appears on a mutating `http_request`**, because
  that is the only case where it changes behaviour. Its two help strings say what
  each state actually does; "off" is the safe default and must not read as a
  missing feature.
- **`idempotency: null` is sent explicitly, not omitted.** `buildConfig` drops the
  old key from `preserved` first, so an omission would leave the field absent and
  indistinguishable — null is what the backend reads as "no dedupe promise".

## The `notify` tool type in the UI (2026-08-23)

`components/tools/tool-dialog.tsx` gained a fourth type and `ToolType` in
`lib/api.ts` gained `"notify"`. Backend contracts are in apps/api/CLAUDE.md's
notifications section; the frontend-specific points:

- **`notify` has no mutating switch**, joining `knowledge_search` in that. Both
  are rejected by the backend outright, so `canMutate` excludes them — the
  switch keeps its state across a type change, and offering it would send a flag
  that 422s.
- **Only `in_app` and `webhook` appear.** `email`/`whatsapp`/`slack` are in the
  `notifications.channel` vocabulary with nothing delivering them, and the
  backend rejects them by name. Same rule as the trigger dropdown dropping
  `email`/`event`: never offer a value the API refuses.
- **The webhook URL field appears only on the webhook channel**, because
  `_notify_config` rejects a `url` on a channel that does not use one — so
  `buildConfig` omits the key entirely rather than sending an empty string.
- **There is no in-app notification bell yet.** `GET /api/v1/notifications`
  exists and is unconsumed, exactly the shape `/api/v1/tools` was in before the
  Tools page. `in_app` rows are real and readable through the API; nothing in
  `apps/web` renders them. That is the next frontend piece, not an oversight.

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

## Agents preview page (2026-08-21)

`app/(dashboard)/agents/page.tsx`. Replaces the dead `Agents · Soon` sidebar
row — a label with a badge, no href and nothing to click.

- **The sidebar now has two lists.** `navItems` (working destinations) and
  `previewItems`, rendered below a rule and given a `Preview` badge through
  `NavLink`'s new optional `badge` prop. `activeNavItem` searches **both**, or
  `/agents` renders the fallback header title ("Workflows"). Add future
  part-built destinations to `previewItems` rather than reintroducing a disabled
  row: an unclickable nav item carries the same visual weight as a working one
  and teaches the reader nothing.
- **The page's rule is that nothing is aspirational without saying so.**
  Everything under "What you can build today" links to a surface that works;
  everything under "Where this is going" is marked not-built and carries the
  engineering reason rather than a quarter. The ReAct card states the real
  blocker — an agent's own tool calls have no node in the graph, so
  `validate_mutating_approval` structurally cannot see them — because that
  constraint IS the product's argument. Softening it to "coming soon" would sell
  the opposite of what this platform is for.
- **`DisplayCards` descriptions must stay short.** The stack is skewed 8° and
  each card is `max-w-[22rem]` with a fading `after:` gradient over its right
  edge, so a description much past ~28 characters reads as text escaping the
  card. Matched to the Knowledge empty state's lengths.
- **No new dependency, and no 21st.dev MCP.** It is still in `.mcp.json` and
  still unauthenticated (verified again 2026-08-21 — no tool is reachable), so
  its components live here hand-adapted onto the oklch tokens:
  `components/ui/display-cards.tsx` and `ai-text-loading.tsx` both carry headers
  listing exactly what was changed from upstream and why.
- `AgentsIcon` joins `components/ui/animated-icons/` under that file's three
  rules. It blinks, deliberately the smallest motion in the set: the row leads
  to mostly-unbuilt work and should not be the liveliest thing in the sidebar.
