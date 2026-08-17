import { describe, expect, it } from "vitest";
import { buildApprovalSummary, formatApprovalAmount } from "@/lib/approval-summary";

/**
 * The exact shape `human_approval_handler` puts in `interrupt_payload`, for the
 * seeded invoice workflow held at its gate. Kept verbatim rather than trimmed:
 * the module's whole job is to find three fields inside a realistic blob, and a
 * tidied-up fixture would not exercise that.
 */
const INVOICE_OUTPUTS = {
  extract_invoice: {
    vendor_name: "Acme Vendor LLC",
    invoice_number: "INV-2291",
    purchase_order_number: "PO-4471",
    total_amount: 4200,
    currency: "USD",
    invoice_date: "2026-08-11",
    due_date: "2026-09-10",
    line_item_summary: "120 units of AC-2291-B at 35.00 each.",
    policy_question: "What approval is required for a 4,200 USD invoice from Acme Vendor LLC?",
  },
  policy_lookup: {
    query: "What approval is required for a 4,200 USD invoice from Acme Vendor LLC?",
    hit_count: 2,
    hits: [{ document_id: "d1", document_name: "ap-policy.md", chunk_index: 1, content: "…", score: 0.56 }],
  },
  validate_invoice: {
    within_policy: true,
    approval_required_by_policy: true,
    account_code: "5100",
    findings: ["Three-way match succeeds against PO-4471 and GR-2214.", "Total exceeds the USD 1,000 approval threshold."],
    policy_citation: "Any invoice with a gross total above USD 1,000.00 requires explicit human approval (Accounts Payable Policy §2).",
    recommendation: "Approve — the invoice matches the purchase order exactly and the only exception is the value threshold.",
  },
};

describe("buildApprovalSummary", () => {
  it("derives the wireframe's sentence from a real invoice run", () => {
    const summary = buildApprovalSummary(INVOICE_OUTPUTS);
    expect(summary.headline).toBe("Approve $4,200.00 to Acme Vendor LLC?");
    expect(summary.derived).toBe(true);
  });

  it("attributes the request to the node that produced the amount", () => {
    // `document-cards.ts`'s approval card shows "Requested by: extract_invoice".
    expect(buildApprovalSummary(INVOICE_OUTPUTS).facts).toContainEqual({ label: "Requested by", value: "extract_invoice" });
  });

  it("carries the reference, the rationale and the cited clause", () => {
    const summary = buildApprovalSummary(INVOICE_OUTPUTS);
    expect(summary.facts).toContainEqual({ label: "Reference", value: "INV-2291" });
    expect(summary.rationale).toMatch(/^Approve — the invoice matches/);
    expect(summary.citation).toMatch(/USD 1,000.00 requires explicit human approval/);
    expect(summary.findings).toHaveLength(2);
  });

  it("reads an expense claim through the same conventions", () => {
    const summary = buildApprovalSummary({
      read_claim: { claimant: "A. Novak", claim_reference: "EXP-8821", currency: "USD", total_amount: 1280.55 },
      assess_claim: {
        compliant: false,
        violations: ["Client dinner of 412.00 has no receipt (policy §3 requires one above USD 25.00)."],
        reimbursable_amount: 700.55,
        summary: "Reject the two breaching lines and reimburse the rest.",
      },
    });
    // total_amount outranks reimbursable_amount: the reviewer is approving a
    // claim, and the claimed figure is the one the decision is about.
    expect(summary.headline).toBe("Approve $1,280.55 to A. Novak?");
    expect(summary.findings).toHaveLength(1);
  });

  // --- the never-invent rule ------------------------------------------------

  it("falls back to the generic headline when nothing can be derived", () => {
    const summary = buildApprovalSummary({ answer_question: { answer: "25 days.", answered_from_handbook: true } });
    expect(summary.derived).toBe(false);
    expect(summary.headline).toBe("This run is waiting on your approval.");
  });

  // Each case is wrapped in its own tuple: vitest spreads a bare array element
  // into separate arguments, so `[1, 2, 3]` would arrive as three params.
  it.each([[null], [undefined], ["not an object"], [42], [[1, 2, 3]]])("survives a %p payload", (payload) => {
    const summary = buildApprovalSummary(payload);
    expect(summary.derived).toBe(false);
    expect(summary.facts).toEqual([]);
    expect(summary.findings).toEqual([]);
  });

  it("ignores node outputs that are not objects", () => {
    expect(buildApprovalSummary({ a: "text", b: null, c: 7, d: { vendor_name: "Acme Vendor LLC" } }).headline).toBe(
      "Approve this action for Acme Vendor LLC?",
    );
  });

  it("never prints an amount it could not read as a number", () => {
    // "about 4200" must not become $NaN or $0.00 — the field is simply absent.
    expect(buildApprovalSummary({ n: { total_amount: "about 4200", vendor_name: "Acme Vendor LLC" } }).headline).toBe(
      "Approve this action for Acme Vendor LLC?",
    );
  });

  it("accepts a numeric string, because extraction agents emit them", () => {
    expect(buildApprovalSummary({ n: { total_amount: "4,200.00", currency: "USD", vendor_name: "Acme Vendor LLC" } }).headline).toBe(
      "Approve $4,200.00 to Acme Vendor LLC?",
    );
  });

  it("treats an empty string as absent rather than as a party named ''", () => {
    expect(buildApprovalSummary({ n: { vendor_name: "   ", total_amount: 10, currency: "USD" } }).headline).toBe("Approve $10.00?");
  });

  it("drops non-string entries from a findings list", () => {
    expect(buildApprovalSummary({ n: { findings: ["real", null, 3, "  ", "also real"] } }).findings).toEqual(["real", "also real"]);
  });
});

describe("formatApprovalAmount", () => {
  it("groups thousands and always shows 2dp", () => {
    expect(formatApprovalAmount(4200, "USD")).toBe("$4,200.00");
    expect(formatApprovalAmount(1280.5, "USD")).toBe("$1,280.50");
    expect(formatApprovalAmount(7, "USD")).toBe("$7.00");
    expect(formatApprovalAmount(1234567.891, "USD")).toBe("$1,234,567.89");
  });

  it("prints a currency it has no symbol for rather than dropping it", () => {
    // Dropping the code would render a euro invoice as a dollar one.
    expect(formatApprovalAmount(4200, "EUR")).toBe("4,200.00 EUR");
    expect(formatApprovalAmount(4200, "gbp")).toBe("4,200.00 GBP");
  });

  it("omits the symbol entirely when no currency was extracted", () => {
    expect(formatApprovalAmount(4200, null)).toBe("4,200.00");
  });

  it("keeps the sign on a credit note", () => {
    expect(formatApprovalAmount(-4200, "USD")).toBe("$-4,200.00");
  });

  it("does not use toLocaleString currency formatting", () => {
    // Guards the documented "US$49" trap: this must not vary by locale.
    expect(formatApprovalAmount(49, "USD")).toBe("$49.00");
  });
});
