/**
 * Script for the scroll-scrubbed run film on the marketing landing page.
 *
 * The film dramatises one real execution of an Orkest workflow, in the shape
 * the product actually produces: a webhook trigger, an agent node emitting a
 * structured output, a condition node routing on a field, a `human_approval`
 * interrupt, a mutating tool call, and a completed run carrying token and cost
 * figures.
 *
 * The beat list is data so the film's *choreography* stays testable while its
 * *rendering* stays in the component. `beatAtProgress` is the one function the
 * GSAP scrubber calls on every tick.
 *
 * Fidelity rules — these keep the film honest against the running product:
 *   - Node keys look like real `node_key`s (snake_case, suffixed).
 *   - `waiting_approval` is a real `WorkflowRun.status`; so are `running` and
 *     `completed`. Do not invent statuses here that the API cannot return.
 *   - The approval beat writes nothing. That is the entire point of the film,
 *     and it mirrors `human_approval_handler` interrupting before the mutating
 *     tool node downstream ever runs.
 */

export type FilmNodeKind = "trigger" | "agent" | "condition" | "human_approval" | "tool" | "end";

export type FilmNodeState = "pending" | "running" | "waiting" | "succeeded";

/** Mirrors the subset of `WorkflowRun.status` this film can reach. */
export type FilmRunStatus = "running" | "waiting_approval" | "completed";

export interface FilmNode {
  key: string;
  kind: FilmNodeKind;
  label: string;
}

/** The chain rendered down the left rail. Order is execution order. */
export const FILM_NODES: readonly FilmNode[] = [
  { key: "invoice_received", kind: "trigger", label: "Invoice received" },
  { key: "extract_invoice", kind: "agent", label: "Extract invoice" },
  { key: "check_amount", kind: "condition", label: "Check amount" },
  { key: "approval_1", kind: "human_approval", label: "Finance approval" },
  { key: "post_to_erp", kind: "tool", label: "Post to ERP" },
  { key: "run_complete", kind: "end", label: "Complete" },
] as const;

export type InspectorView =
  | { view: "payload"; signature: string; body: Record<string, string | number> }
  | { view: "thinking"; model: string; lines: readonly string[] }
  | { view: "fields"; fields: readonly { label: string; value: string; confident: boolean }[] }
  | { view: "route"; expression: string; taken: string; other: string }
  | { view: "approval"; amount: string; vendor: string; requester: string }
  | { view: "receipt"; reference: string; system: string; postedAt: string }
  | { view: "summary"; tokens: number; cost: string; duration: string };

export interface FilmBeat {
  /** Stable id, used as the GSAP label and the React key. */
  id: string;
  /** Which node in `FILM_NODES` this beat belongs to. */
  nodeKey: string;
  /** State that node takes on during this beat. */
  nodeState: Extract<FilmNodeState, "running" | "waiting" | "succeeded">;
  runStatus: FilmRunStatus;
  /** The sentence shown beneath the film. This is where the argument lives. */
  caption: string;
  inspector: InspectorView;
}

export const FILM_BEATS: readonly FilmBeat[] = [
  {
    id: "trigger",
    nodeKey: "invoice_received",
    nodeState: "succeeded",
    runStatus: "running",
    caption: "A vendor invoice arrives on a signed webhook. The signature is checked before anything else happens.",
    inspector: {
      view: "payload",
      signature: "HMAC-SHA256 verified",
      body: {
        vendor: "Acme Vendor LLC",
        document: "INV-2291",
        received: "2026-08-11T09:14:02Z",
      },
    },
  },
  {
    id: "agent-thinking",
    nodeKey: "extract_invoice",
    nodeState: "running",
    runStatus: "running",
    caption: "An agent node reads the document. It returns a typed object, not a paragraph of prose.",
    inspector: {
      view: "thinking",
      model: "gpt-5",
      lines: ["Reading document", "Locating line items", "Resolving vendor against ledger"],
    },
  },
  {
    id: "agent-output",
    nodeKey: "extract_invoice",
    nodeState: "succeeded",
    runStatus: "running",
    caption: "Structured output, enforced by schema. Every field is one the workflow declared in advance.",
    inspector: {
      view: "fields",
      fields: [
        { label: "vendor_name", value: "Acme Vendor LLC", confident: true },
        { label: "total_amount", value: "4200.00", confident: true },
        { label: "currency", value: "USD", confident: true },
        { label: "due_date", value: "2026-09-10", confident: false },
      ],
    },
  },
  {
    id: "condition",
    nodeKey: "check_amount",
    nodeState: "succeeded",
    runStatus: "running",
    caption: "A condition routes on a field. No expression is evaluated as code — the rule is structured data.",
    inspector: {
      view: "route",
      expression: "total_amount  gt  1000",
      taken: "needs_approval",
      other: "auto_post",
    },
  },
  {
    id: "approval",
    nodeKey: "approval_1",
    nodeState: "waiting",
    runStatus: "waiting_approval",
    caption:
      "And here it stops. Nothing has been written to your ERP, and nothing will be until a person says so.",
    inspector: {
      view: "approval",
      amount: "$4,200.00",
      vendor: "Acme Vendor LLC",
      requester: "extract_invoice",
    },
  },
  {
    id: "tool",
    nodeKey: "post_to_erp",
    nodeState: "succeeded",
    runStatus: "running",
    caption: "Approved. Only now does the mutating tool run, and it records what it did before it does it.",
    inspector: {
      view: "receipt",
      reference: "AP-88401-2291",
      system: "NetSuite · accounts_payable",
      postedAt: "09:14:41Z",
    },
  },
  {
    id: "complete",
    nodeKey: "run_complete",
    nodeState: "succeeded",
    runStatus: "completed",
    caption: "Thirty-nine seconds, one decision, and a trail that cannot be edited afterwards.",
    inspector: {
      view: "summary",
      tokens: 3412,
      cost: "$0.0284",
      duration: "39.2s",
    },
  },
] as const;

/**
 * Maps a 0–1 scrub progress onto a beat index.
 *
 * Clamps rather than throwing: ScrollTrigger can report marginally out-of-range
 * progress during a resize or a rapid fling, and a film that crashes on an
 * overscroll is worse than one that shows its last frame.
 */
export function beatIndexAtProgress(progress: number, beatCount = FILM_BEATS.length): number {
  if (!Number.isFinite(progress) || beatCount <= 0) return 0;
  const clamped = Math.min(Math.max(progress, 0), 1);
  // `beatCount - 1` so progress exactly 1 lands on the final beat rather than
  // one past the end.
  return Math.min(Math.round(clamped * (beatCount - 1)), beatCount - 1);
}

/**
 * Resolves the visual state of every node at a given beat.
 *
 * A node is `succeeded` once any *later* beat has moved past it, `running` or
 * `waiting` during its own beat, and `pending` before it is reached. Nodes with
 * several beats (the agent thinks, then returns) take the state of the latest
 * beat that mentions them.
 */
export function nodeStatesAtBeat(
  beatIndex: number,
  beats: readonly FilmBeat[] = FILM_BEATS,
  nodes: readonly FilmNode[] = FILM_NODES,
): Record<string, FilmNodeState> {
  const states: Record<string, FilmNodeState> = {};
  for (const node of nodes) states[node.key] = "pending";

  const index = Math.min(Math.max(beatIndex, 0), beats.length - 1);
  for (let i = 0; i <= index; i += 1) {
    const beat = beats[i];
    // Anything before the current beat has necessarily finished — a run cannot
    // advance past a node that is still waiting.
    states[beat.nodeKey] = i === index ? beat.nodeState : "succeeded";
  }

  return states;
}

/** Header badge copy for a run status. Terminal states read as past tense. */
export function runStatusLabel(status: FilmRunStatus): string {
  switch (status) {
    case "running":
      return "Running";
    case "waiting_approval":
      return "Waiting for approval";
    case "completed":
      return "Completed";
  }
}
