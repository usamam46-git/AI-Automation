# Volume 3 — Frontend Architecture
### AI Automation Platform — Engineering Blueprint, Volume 3 of 7

---

## Table of Contents

1. [Next.js Application Structure](#1-nextjs-application-structure)
2. [React Architecture & State Management](#2-react-architecture--state-management)
3. [Design System](#3-design-system)
4. [The Workflow Builder (React Flow)](#4-the-workflow-builder-react-flow)
5. [Dashboard](#5-dashboard)
6. [Execution Viewer](#6-execution-viewer)
7. [Knowledge Base UI](#7-knowledge-base-ui)
8. [Agent Playground](#8-agent-playground)
9. [Chat Interface](#9-chat-interface)
10. [Admin Panel & Organization Settings](#10-admin-panel--organization-settings)
11. [Analytics & Cost Dashboard](#11-analytics--cost-dashboard)
12. [Billing-Ready UI](#12-billing-ready-ui)
13. [Dark Mode, Accessibility, Responsive Design](#13-dark-mode-accessibility-responsive-design)

---

## 1. Next.js Application Structure

### 1.1 Folder layout (App Router)

```
apps/web/app/
├── (marketing)/               # Public site — SSR/SSG for SEO
│   ├── page.tsx                 # Landing page
│   ├── pricing/page.tsx
│   └── layout.tsx
├── (auth)/
│   ├── login/page.tsx
│   ├── register/page.tsx
│   └── layout.tsx                # Minimal centered auth shell
└── (dashboard)/
    ├── layout.tsx                 # Sidebar + topbar shell, org/workspace switcher
    ├── workflows/
    │   ├── page.tsx               # Workflow list
    │   └── [workflowId]/
    │       ├── builder/page.tsx   # React Flow canvas
    │       └── settings/page.tsx
    ├── executions/
    │   ├── page.tsx
    │   └── [runId]/page.tsx       # Execution viewer/timeline
    ├── agents/
    │   ├── page.tsx
    │   └── [agentId]/playground/page.tsx
    ├── knowledge-base/
    ├── chat/
    ├── analytics/
    └── settings/
        ├── organization/page.tsx
        ├── members/page.tsx
        ├── billing/page.tsx
        └── api-keys/page.tsx
```

**Route group rationale:** `(marketing)`, `(auth)`, and `(dashboard)` are Next.js route groups sharing no layout, letting the marketing site stay a fast, SEO-optimized static/SSR surface while the dashboard is a heavier, client-interactive application shell — without duplicating a Next.js project.

### 1.2 Rendering strategy

| Route | Strategy | Reason |
|---|---|---|
| Marketing pages | Static (SSG) + ISR | SEO, fastest possible load |
| Login/register | SSR | No stale auth state |
| Dashboard shell (`layout.tsx`) | Server Component, fetches org/user once | Avoids client-side waterfall for identity data |
| Workflow builder canvas | Client Component (`"use client"`) | Heavy interactivity (drag/drop, canvas state) is incompatible with server rendering |
| Data tables (executions, audit log) | Server Component shell + client-side React Query for pagination/live updates | First paint has data (no spinner flash), subsequent interaction is client-driven |

---

## 2. React Architecture & State Management

### 2.1 Three kinds of state, three tools

| State kind | Tool | Example |
|---|---|---|
| **Server state** (anything from the API) | React Query | Workflow list, execution history, KB documents |
| **Client/UI state** (ephemeral, not persisted server-side) | Zustand | Canvas node selection, builder "mode" (edit/view), sidebar collapsed |
| **Local component state** | `useState`/`useReducer` | Form field values before submit, modal open/closed |

**Rule:** if a piece of state could be derived from a GET request, it belongs in React Query, never duplicated into Zustand — this is the single most common state-management bug in node-based editors (canvas data drifting from server truth), and the platform avoids it by treating the React Flow canvas's node/edge arrays as a **React Query cache entry** that Zustand only annotates (selection state, hover state) rather than owning.

### 2.2 Example: workflow builder state split

```typescript
// Server state (React Query) — the actual graph data
const { data: graph } = useQuery({
  queryKey: ['workflow', workflowId, 'draft'],
  queryFn: () => api.getDraftGraph(workflowId),
});

// Client state (Zustand) — UI-only concerns
const useBuilderStore = create<BuilderState>((set) => ({
  selectedNodeId: null,
  isPanelOpen: false,
  setSelectedNode: (id) => set({ selectedNodeId: id, isPanelOpen: !!id }),
}));

// Mutation writes back through React Query, never through Zustand
const saveNode = useMutation({
  mutationFn: (node: WorkflowNode) => api.upsertNode(workflowId, node),
  onSuccess: () => queryClient.invalidateQueries(['workflow', workflowId, 'draft']),
});
```

### 2.3 React Query conventions

- Query keys are hierarchical arrays (`['workflow', id, 'draft']`) so invalidation can target a whole subtree (`invalidateQueries(['workflow', id])`).
- Optimistic updates are used for high-frequency, low-risk mutations (renaming a node, moving a node on canvas) with rollback on error; **not** used for run-triggering or approval actions, where the UI waits for server confirmation given the real-world consequence of those actions.
- WebSocket events (execution status) write directly into the React Query cache via `queryClient.setQueryData(...)`, so live updates and fetched data share one source of truth rather than a parallel "live state" object.

---

## 3. Design System

*(Full visual-identity rationale — palette, type scale, motion language — is developed against the `frontend-design` skill during implementation; this section defines the structural contract.)*

| Token category | Examples |
|---|---|
| Color | `--color-primary-*`, `--color-surface-*`, `--color-status-{success,warning,danger,info}` (used consistently for run-status badges) |
| Typography | Display/heading font for marketing + dashboard headers; a monospace face for node config/JSON views |
| Spacing | 4px base unit scale, consistent across canvas and forms |
| Elevation | 3-tier shadow scale for panels/modals/canvas nodes |
| Motion | Framer Motion presets: `panelSlide`, `nodeSnap`, `statusPulse` (used on running-node canvas indicators) |

Tokens live in `packages/ui-tokens` and are consumed by both Tailwind config (`tailwind.config.ts` extends theme from tokens) and any Framer Motion variant definitions, so a rebrand touches one package.

`shadcn/ui` primitives (Button, Dialog, DropdownMenu, Tabs, Toast, etc.) are copied into `components/ui/` (per shadcn's copy-in-repo model) and re-themed via the token CSS variables rather than left at library defaults — this is what gives the product a distinctive identity instead of "looking like every other shadcn app."

### 3.1 Implemented visual identity (iOS/macOS-inspired) — addendum

The token categories above were realized, during the initial Next.js/shadcn build, as a specific **iOS/macOS-inspired visual language**: calm, compact, and premium-feeling rather than a typical dense SaaS-admin dashboard. These are the concrete values in use and should be treated as the locked reference for any new page or component:

| Token category | Concrete implemented values |
|---|---|
| **Corners** | `rounded-xl` (12px) default for cards/panels/modals; `rounded-lg` (8px) for buttons/inputs/badges; `rounded-full`/`rounded-2xl` for avatars and app-icon-style squares. Nothing sharp-cornered anywhere in the product. |
| **Shadows** | Soft, low-opacity, multi-layer shadows only (`shadow-black/5` to `shadow-black/10` range in light mode) — never a hard single drop-shadow. Resting cards: `shadow-sm`; elevated surfaces (open dropdowns, modals, popovers): `shadow-lg`. Hover on interactive cards lifts subtly (`shadow-sm` → `shadow-md` + 1-2px translate-y, ~150-200ms ease-out). |
| **Spacing (applied)** | The 4px base scale above is applied compactly — density closer to macOS System Settings or Linear than a marketing page's generous whitespace. |
| **Typography (applied)** | System font stack (`font-sans`, no custom web font). Page titles `text-xl font-semibold`; section headers `text-sm font-medium text-muted-foreground`; body `text-sm`. No oversized marketing-style headings inside the dashboard. |
| **Motion (applied)** | Subtle, physical-feeling only — fades and gentle scale/slide, 150-250ms ease-out, no springy overshoot. Modals fade + scale from 95%→100% (desktop-native feel), not slide-from-edge. |
| **Color — light mode** | Clean white/near-white background (`0 0% 100%`–`0 0% 98%`) — standard shadcn light defaults. |
| **Color — dark mode (important, non-default)** | TRUE BLACK, not shadcn's default blue-tinted slate. `--background`: `0 0% 4%`–`0 0% 7%` (near `#0a0a0a`). Elevated/card surfaces: `0 0% 9%`–`0 0% 11%`, neutral gray (never blue-tinted). Borders: low-opacity white (`white/10`–`white/15`), not mid-gray. This is a deliberate correction to shadcn's out-of-the-box dark theme and must be preserved anywhere shadcn primitives are reused (including the marketing site, §3.2). |
| **Status colors (applied)** | Desaturated, calm badge variants for the `--color-status-*` tokens above (workflow status, run status) — never bright/saturated, even in light mode. |

The dark-mode override values live in `globals.css` under `.dark` and take precedence over shadcn's generated defaults. Toggle via `next-themes`, respecting system preference by default, with a manual override in the topbar.

### 3.2 Consistency requirement for the marketing site

The marketing site (`app/(marketing)/`, §1.1) is a separate route group from the dashboard, but it must reuse the **same tokens and dark-mode correction** from §3.1 — same corner radii, same shadow treatment, same true-black dark mode, same shadcn-primitive re-theming. It should not be designed as a visually separate "brochure site" with its own palette or component library.

**If someone else (e.g., a collaborator without context on this blueprint) is building the marketing/landing page:** point them to §3.1 first, plus `packages/ui-tokens` and the `.dark` CSS variable overrides in `globals.css`, rather than letting them start from shadcn's untouched defaults or a generic template. The two most common mistakes to flag explicitly: (1) using shadcn's default dark theme instead of the true-black override above, and (2) using sharp corners or heavy/hard shadows that don't match the dashboard's soft, rounded, iOS-style language.

---

## 4. The Workflow Builder (React Flow)

### 4.1 Node taxonomy (visual)

| Node type | Icon/color | Represents |
|---|---|---|
| **Trigger** | Green, rounded rectangle | Start of the graph — email, schedule, webhook, manual |
| **Agent** | Purple, brain icon | An LLM reasoning step, possibly with tools |
| **Tool** | Blue, wrench icon | A deterministic action — API call, ERP write, calculation |
| **Condition** | Amber diamond | Conditional branch (`if confidence < 0.8`) |
| **Human Approval** | Red, person icon | Interrupt requiring a human decision |
| **Subgraph** | Gray, nested-box icon | Embeds a reusable sub-workflow |
| **End** | Dark rounded rectangle | Terminal node(s) — a graph can have multiple ends (e.g., "Approved" vs. "Rejected") |

### 4.2 Wireframe — Builder canvas

```
┌─────────────────────────────────────────────────────────────────────────┐
│ ← Workflows   Invoice Processing v3 (draft)      [Test Run] [Publish ▾] │
├───────────┬───────────────────────────────────────────────┬─────────────┤
│  Node      │                                              │  Node        │
│  Palette   │     ┌────────┐      ┌───────────┐            │  Config      │
│  ┌──────┐  │     │ Trigger │─────▶│  Extract   │           │  Panel       │
│  │Trigger│ │     │ (Email) │      │  Invoice   │──┐        │              │
│  ├──────┤  │     └────────┘      │  (Agent)   │  │        │  ▸ Node:     │
│  │Agent  │ │                     └───────────┘  │        │    Extract   │
│  ├──────┤  │                                      ▼        │    Invoice   │
│  │Tool   │ │                            ┌──────────────┐   │              │
│  ├──────┤  │                            │  Confidence   │   │  Model:      │
│  │Cond.  │ │                            │  >= 0.8?      │   │  gpt-4.1     │
│  ├──────┤  │                            │  (Condition)  │   │              │
│  │Approv.│ │                            └──────┬───────┘   │  Prompt:     │
│  └──────┘  │                        yes │      │ no        │  [Select ▾]  │
│            │                            ▼      ▼           │              │
│            │                     ┌─────────┐ ┌───────────┐ │  Tools:      │
│            │                     │ Journal  │ │  Human     │ │  ☑ ERP.get_ │
│            │                     │ Entry    │ │  Approval  │ │    vendor    │
│            │                     │ (Tool)   │ │            │ │  ☐ OCR.rerun │
│            │                     └─────────┘ └───────────┘ │              │
│            │                                                │  [Save]      │
├───────────┴───────────────────────────────────────────────┴─────────────┤
│ Zoom: 100%    ⊞ Minimap                              Autosaved 2s ago    │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.3 React Flow implementation notes

- **Custom node components** per node type (`<AgentNode>`, `<ToolNode>`, `<ConditionNode>`, ...) registered via React Flow's `nodeTypes` map; each renders a live status ring (idle/running/succeeded/failed) driven by the execution WebSocket stream when viewing a *run overlay* on the builder canvas.
- **Edges** support conditional labels (rendered as small pill badges reading the edge's `condition` expression) so branching logic is legible without opening the config panel.
- **Validation-in-canvas:** the compiler's validation errors (Volume 2 §6.1) are mapped back to node IDs and rendered as red outline + inline error tooltip directly on the offending node — never just a toast notification disconnected from *where* the problem is.
- **Autosave + optimistic local state:** node drags/moves are saved via debounced (800ms) mutation calls; the canvas never blocks user interaction on a save round-trip.

---

## 5. Dashboard

### 5.1 Wireframe — Home dashboard

```
┌───────────────────────────────────────────────────────────────────────┐
│  Acme Corp ▾   Finance Workspace ▾              🔔  ⚙  👤 Jane D.     │
├───────────────────────────────────────────────────────────────────────┤
│  Good morning, Jane 👋                                                 │
│                                                                         │
│  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌─────────────┐│
│  │ Active Runs    │ │ Needs Approval │ │ Cost (MTD)     │ │ Success Rate││
│  │      12        │ │       3        │ │   $842.10      │ │    97.4%   ││
│  └───────────────┘ └───────────────┘ └───────────────┘ └─────────────┘│
│                                                                         │
│  Recent Executions                                    [View all →]    │
│  ┌───────────────────────────────────────────────────────────────┐    │
│  │ ● Running   Invoice Processing        started 2 min ago       │    │
│  │ ✓ Success   Expense Approval           completed 14 min ago    │    │
│  │ ⚠ Waiting   Invoice Processing         needs your approval     │    │
│  │ ✗ Failed    Vendor Registration        ERP timeout, 1 hr ago   │    │
│  └───────────────────────────────────────────────────────────────┘    │
│                                                                         │
│  Your Workflows                                        [+ New]        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐                 │
│  │ Invoice   │ │ Expense   │ │ Leave     │ │ Vendor    │                │
│  │ Processing│ │ Approval  │ │ Approval  │ │ Onboard.  │                │
│  │ ▶ Active  │ │ ▶ Active  │ │ ▶ Active  │ │ ⏸ Paused  │                │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘                 │
└───────────────────────────────────────────────────────────────────────┘
```

Status badges (`● Running`, `✓ Success`, `⚠ Waiting`, `✗ Failed`) use the `--color-status-*` tokens consistently across the dashboard, execution viewer, and canvas node rings — one status vocabulary everywhere in the product.

---

## 6. Execution Viewer

### 6.1 Wireframe — Run detail (timeline view)

```
┌───────────────────────────────────────────────────────────────────────┐
│ ← Executions   Run #b7e1c2a4 · Invoice Processing v3    ⚠ Waiting     │
├───────────────────────┬───────────────────────────────────────────────┤
│  Timeline               │  Node: Extract Invoice                       │
│                          │  ────────────────────────                    │
│  ✓ Trigger (Email)       │  Status: Succeeded · 1.2s · $0.014           │
│  │ 0.1s                  │                                              │
│  ✓ Extract Invoice       │  Input:                                      │
│  │ 1.2s · $0.014         │  { "attachment": "inv-2291.pdf" }             │
│  ✓ Confidence Check      │                                              │
│  │ 0.0s                  │  Output:                                     │
│  ⚠ Human Approval        │  { "vendor": "Acme Vendor LLC",               │
│  │ waiting since 09:14   │    "amount": 4200.00,                        │
│  ○ Journal Entry         │    "confidence": 0.94 }                      │
│  ○ Notification          │                                              │
│  ○ Archive                │  [View raw trace in LangSmith ↗]             │
│                          │                                              │
├───────────────────────┴───────────────────────────────────────────────┤
│  ⚠ This run is waiting on your approval.                              │
│  Approve $4,200.00 to Acme Vendor LLC?     [Reject]   [Approve]        │
└───────────────────────────────────────────────────────────────────────┘
```

- Node icons mirror the builder canvas taxonomy (§4.1) so users recognize a node's type without relearning a second visual language.
- The approval action bar is **sticky** at the bottom whenever a run is in `waiting_approval`, since resolving blocked runs is the highest-priority action a user takes in this surface.
- A "View raw trace in LangSmith" deep link is available to engineering/power users without cluttering the primary UI with full agent reasoning traces by default.

---

## 7. Knowledge Base UI

Document list with status pills (`Uploaded → Processing → Indexed`/`Failed`), drag-and-drop upload, and a **hybrid search preview** panel where an admin can test a query and see which chunks (with relevance scores) would be retrieved — making the otherwise invisible RAG pipeline (Volume 4 §7) inspectable and debuggable by non-engineers.

---

## 8. Agent Playground

A standalone chat-like surface to test an agent version in isolation (before wiring it into a workflow), showing the full tool-call sequence inline (collapsible "Called `erp.get_vendor({...})` → `{...}`" blocks between assistant messages) — this is the primary tool for prompt iteration and is intentionally more verbose/technical than the polished Chat Interface (§9), which is end-user facing.

---

## 9. Chat Interface

An end-user-facing conversational surface (e.g., "ask the Ledger Search agent a question") with streamed responses, source citations for RAG-backed answers (linking back to the originating document/chunk), and a persistent chat history per workspace — this is where non-technical staff interact with agents without ever seeing a workflow graph.

---

## 10. Admin Panel & Organization Settings

| Page | Contents |
|---|---|
| Organization | Name, logo, plan, timezone, data-retention policy |
| Members | Invite/remove, role assignment table, pending-invite status |
| API Keys | Create/revoke, scope selection, last-used timestamp |
| Integrations | Connected ERPs/email/WhatsApp, OAuth connect/reconnect flows, health status per integration |
| Audit Log | Filterable, exportable (CSV) table of every `audit_logs` row scoped to the org |
| Roles & Permissions | Custom role builder (enterprise plan) — checkbox matrix over the permission-string vocabulary (Volume 2 §10.2) |

---

## 11. Analytics & Cost Dashboard

Charts (via `recharts`): runs over time by status, cost by workflow, cost by model, average time-to-approval, top failure reasons. Every chart supports a workspace/date-range filter and an "export as CSV" action, since finance stakeholders (the primary buyer persona, Volume 1 §6) need this data portable into their own reporting.

---

## 12. Billing-Ready UI

Plan/usage summary card, invoice history table, payment method management — built against an abstracted `BillingProvider` interface so a payment processor (Stripe) can be wired in post-MVP without a UI rewrite; the UI ships pre-revenue showing usage-based metering (runs, tokens, seats) against plan limits, which doubles as an internal usage-monitoring view even before checkout is live.

---

## 13. Dark Mode, Accessibility, Responsive Design

- **Dark mode:** implemented via CSS variables + a `data-theme` attribute (not a Tailwind `dark:` class scattered per-component), toggled via `next-themes`, respecting `prefers-color-scheme` by default.
- **Accessibility:** all shadcn/ui primitives retain their Radix-based keyboard navigation and ARIA semantics; canvas interactions (React Flow) additionally expose a keyboard-navigable "node list" fallback view for screen-reader users, since a freeform canvas is inherently not screen-reader friendly.
- **Responsive design:** the marketing site and all data-table/settings pages are fully responsive down to mobile; the workflow builder canvas itself is **desktop-only by design** (an explicit product decision, not an oversight) with a "open on desktop to edit" notice on small viewports, while run status/approvals remain mobile-accessible since approving an invoice from a phone is a real use case.

---

*Continue to **Volume 4 — AI Engineering** for the complete LangGraph deep-dive, RAG pipeline, prompt engineering, and evaluation methodology.*