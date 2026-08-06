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
- **Motion**: subtle only, 150–250ms ease-out, no springy overshoot.
- This will apply to the marketing site too, once it's built — it should
  not become a visually separate "brochure site." Note: `app/(marketing)/`
  does not exist yet as of the last verification pass; don't assume it's
  scaffolded.

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

`agent` and `tool` nodes carry their settings **inline** in node `config`,
because the agents and tools modules are models-only. The forms in
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

### Validation is duplicated in two languages — keep them in sync

`lib/graph-validation.ts` mirrors all seven backend rules from
`apps/api/src/modules/workflows/service.py`. This is a real drift risk and
the reason the vitest suite exists. In particular the mutating-approval walk
is **∃-semantics** (flag only when *zero* `human_approval` nodes exist
upstream); tightening it to ∀ would reject the blueprint's own Vol. 5 §1 and
§5 workflows and diverge from the server.

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
- The Executions UI is intentionally NOT built yet. Don't scaffold it
  speculatively, and don't add links promising a page that doesn't exist.