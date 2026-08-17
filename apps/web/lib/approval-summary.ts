/**
 * lib/approval-summary.ts — turn a paused run's upstream node outputs into the
 * sentence a person actually decides on.
 *
 * Vol. 3 §6.1's wireframe shows "Approve $4,200.00 to Acme Vendor LLC?" above
 * the approve/reject buttons. Nothing in the API produces that string, and it
 * deliberately never will: `human_approval_handler` emits
 * `{type: "approval_request", node_outputs: {...}}` and `human_approval` nodes
 * have no config, so there is no message template to fill in. The 15-day plan
 * §4 settles it — **the approval sentence is a frontend concern**, derived here
 * from what the workflow actually produced.
 *
 * ## The one rule: never invent
 *
 * Every value below is lifted verbatim from a node output. If the outputs do
 * not contain an amount, no amount is shown — the caller falls back to the
 * generic headline and the raw JSON, which is what shipped before this module
 * and is always honest. A derived sentence that guesses at a figure is worse
 * than no sentence at all: it is the single line a reviewer reads before
 * authorising a write to a real system.
 *
 * This is why there is no default currency, no "0" for a missing amount, and no
 * attempt to sum line items. Absent means absent.
 *
 * ## How fields are found
 *
 * A convention, not a schema. Agent output schemas are authored on the canvas
 * and this module cannot know them, so it looks for the field names the demo
 * workflows and the blueprint's own examples use, in priority order, across
 * every node output in execution order. First match wins, and the node that
 * supplied the amount becomes the "requested by" attribution — which is exactly
 * what `document-cards.ts`'s approval card shows (`Requested by:
 * extract_invoice`).
 *
 * Adding a name to one of the lists below is cheap and safe. Reordering one is
 * not: the first match wins, so moving `amount` above `total_amount` would make
 * a workflow that emits both show the wrong figure.
 */

/** Money field names, most specific first. */
const AMOUNT_KEYS = ["total_amount", "reimbursable_amount", "gross_amount", "amount", "total", "gross"] as const;

/** Who is being paid, or on whose behalf. */
const PARTY_KEYS = ["vendor_name", "supplier_name", "counterparty", "payee", "claimant", "employee_name", "vendor"] as const;

/** The document a human would quote when asking about this. */
const REFERENCE_KEYS = ["invoice_number", "claim_reference", "document_number", "reference"] as const;

/** One sentence of justification, most decision-shaped first. */
const RATIONALE_KEYS = ["recommendation", "summary", "rationale", "reason"] as const;

/** A quoted clause, shown separately from the rationale because it is evidence. */
const CITATION_KEYS = ["policy_citation", "citation", "policy_reference"] as const;

/** Findings/violations lists, rendered as the "what was checked" bullets. */
const FINDING_KEYS = ["violations", "findings", "issues", "exceptions"] as const;

export interface ApprovalFact {
  label: string;
  value: string;
}

export interface ApprovalSummary {
  /**
   * The question above the buttons. Always present — falls back to the generic
   * wording when nothing could be derived.
   */
  headline: string;
  /** True when `headline` was derived from real outputs rather than defaulted. */
  derived: boolean;
  /** Compact label/value pairs: reference, requested by, and so on. */
  facts: ApprovalFact[];
  /** One sentence of context under the headline, or null. */
  rationale: string | null;
  /** A quoted policy clause, or null. */
  citation: string | null;
  /** Short bullets naming what was checked or what failed. */
  findings: string[];
}

const GENERIC_HEADLINE = "This run is waiting on your approval.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Find the first `keys` entry present on any node output.
 *
 * Returns the node key alongside the value so the caller can attribute the
 * figure to the node that produced it. Node outputs are walked in insertion
 * order, which is execution order — LangGraph writes `node_outputs` by
 * copy-then-merge as each node completes, so an earlier node's key is inserted
 * first and stays first. Where two nodes both emit `total_amount`, the earlier
 * one wins, which matches "what was extracted" over "what was recomputed".
 */
function findField(
  nodeOutputs: Record<string, unknown>,
  keys: readonly string[],
): { nodeKey: string; value: unknown } | null {
  for (const key of keys) {
    for (const [nodeKey, output] of Object.entries(nodeOutputs)) {
      if (!isRecord(output)) continue;
      const value = output[key];
      if (value !== undefined && value !== null && value !== "") return { nodeKey, value };
    }
  }
  return null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  // A number arriving as a string is common enough from an extraction agent
  // that rejecting it would lose the headline on a working workflow. Anything
  // that is not cleanly numeric is still rejected rather than coerced to NaN.
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, "").trim());
    return Number.isFinite(parsed) && value.trim() !== "" ? parsed : null;
  }
  return null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * `4200` + `USD` → `$4,200.00`.
 *
 * The symbol and the grouping are hardcoded for USD rather than going through
 * `toLocaleString(..., {style: "currency"})`, which renders "US$4,200.00" under
 * several locales. That is the same trap `formatMonthlyCost` in
 * `lib/dashboard-stats.ts` and NumberFlow on the marketing page both document,
 * and three formatters disagreeing about the same figure on one screen is worse
 * than any of them being slightly wrong.
 *
 * A non-USD currency renders as `4,200.00 EUR` — a code we do not have a symbol
 * for is printed, never dropped, because dropping it turns a euro invoice into a
 * dollar one.
 */
export function formatApprovalAmount(amount: number, currency: string | null): string {
  // Always 2dp. This is a payable amount, not a per-run cost — `formatCost`'s
  // 4dp branch exists because a single agent call costs fractions of a cent,
  // and rendering an invoice as $4,200.0000 would read as a different figure.
  const [whole, fraction] = amount.toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const formatted = `${grouped}.${fraction}`;
  if (!currency) return formatted;
  const code = currency.trim().toUpperCase();
  return code === "USD" ? `$${formatted}` : `${formatted} ${code}`;
}

function collectFindings(nodeOutputs: Record<string, unknown>): string[] {
  const found = findField(nodeOutputs, FINDING_KEYS);
  if (!found || !Array.isArray(found.value)) return [];
  return found.value.map(asNonEmptyString).filter((line): line is string => line !== null);
}

/**
 * Build the approval summary from a run's `interrupt_payload.node_outputs`.
 *
 * Safe on anything: a null payload, a payload with no `node_outputs`, outputs
 * that are strings rather than objects. All of those produce the generic
 * headline with `derived: false`, and the bar renders the raw JSON as before.
 */
export function buildApprovalSummary(nodeOutputs: unknown): ApprovalSummary {
  const empty: ApprovalSummary = {
    headline: GENERIC_HEADLINE,
    derived: false,
    facts: [],
    rationale: null,
    citation: null,
    findings: [],
  };
  if (!isRecord(nodeOutputs)) return empty;

  const amountField = findField(nodeOutputs, AMOUNT_KEYS);
  const amount = amountField ? asFiniteNumber(amountField.value) : null;
  const currency = asNonEmptyString(findField(nodeOutputs, ["currency", "currency_code"])?.value);
  const party = asNonEmptyString(findField(nodeOutputs, PARTY_KEYS)?.value);
  const reference = asNonEmptyString(findField(nodeOutputs, REFERENCE_KEYS)?.value);
  const rationale = asNonEmptyString(findField(nodeOutputs, RATIONALE_KEYS)?.value);
  const citation = asNonEmptyString(findField(nodeOutputs, CITATION_KEYS)?.value);
  const findings = collectFindings(nodeOutputs);

  const facts: ApprovalFact[] = [];
  if (reference) facts.push({ label: "Reference", value: reference });
  // Attribute to the node that produced the money, falling back to the one that
  // named the party. This is the wireframe's "Requested by: extract_invoice".
  const requester = amountField?.nodeKey ?? findField(nodeOutputs, PARTY_KEYS)?.nodeKey ?? null;
  if (requester) facts.push({ label: "Requested by", value: requester });

  let headline = GENERIC_HEADLINE;
  let derived = false;
  if (amount !== null && party) {
    headline = `Approve ${formatApprovalAmount(amount, currency)} to ${party}?`;
    derived = true;
  } else if (amount !== null) {
    headline = `Approve ${formatApprovalAmount(amount, currency)}?`;
    derived = true;
  } else if (party) {
    headline = `Approve this action for ${party}?`;
    derived = true;
  }

  return { headline, derived, facts, rationale, citation, findings };
}
