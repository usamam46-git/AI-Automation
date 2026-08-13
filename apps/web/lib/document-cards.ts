/**
 * The actual documents floating in the 3D scene.
 *
 * ## Why this file exists
 *
 * The first version of the scene drew the objects as octahedrons, boxes and
 * rings. It was abstract, it read as particles rather than as a company, and
 * there was no story in it — a drifting polyhedron cannot say anything. These
 * specs are the fix: every object in the scene is a **real back-office
 * document**, drawn as a readable layout and mapped onto a card. You can read
 * the vendor, the reference and the amount.
 *
 * ## One company, one consistent set of facts
 *
 * Every figure below belongs to a single coherent fiction, and the finance
 * thread deliberately reuses the exact data in `run-film.ts` — Acme Vendor LLC,
 * `INV-2291`, `$4,200.00`, the `extract_invoice` requester. That is what lets
 * scene 3 follow *this specific invoice* through extraction, the amount check,
 * the approval hold and into the ledger, instead of following an anonymous
 * shape. If you change an amount here, change it there too, or the story
 * quietly stops matching itself.
 *
 * The chain that must stay consistent across cards:
 *   PO-4471 → GR-2214 → INV-2291 (Acme Vendor LLC, 4,200.00) → JE-99120
 *   → finance_approval (waiting) → the ERP posting in scene 3.
 *
 * ## Keys
 *
 * Keyed by `SceneNode.id` in `scene-script.ts`. Every node must have a card —
 * a missing one is a blank object in the scene, which is exactly the failure
 * this file replaced.
 */

export type CardTone = "paper" | "gate";

export interface CardRow {
  label: string;
  value: string;
}

export interface DocumentCard {
  /** Small caps label at the top of the card: "INVOICE", "PAYSLIP". */
  kind: string;
  /** The line that identifies this document to a human. */
  title: string;
  /** Document reference, rendered in the monospaced slot. */
  reference: string;
  rows: readonly CardRow[];
  /** Emphasised bottom row, ruled off from the rest. */
  total?: CardRow;
  /**
   * `gate` cards are approval requests: amber rule, amber status pill. Amber
   * rather than red for the same reason the `mutating` badge is amber — an
   * approval gate is the system working, not an error.
   */
  tone: CardTone;
}

export const DOCUMENT_CARDS: Readonly<Record<string, DocumentCard>> = {
  /* ---- People ---------------------------------------------------------- */
  employee_record: {
    kind: "Employee record",
    title: "M. Ferreira",
    reference: "EMP-2041",
    rows: [
      { label: "Department", value: "Finance" },
      { label: "Start date", value: "2023-04-11" },
      { label: "Status", value: "Active" },
    ],
    tone: "paper",
  },
  new_hire: {
    kind: "New hire",
    title: "J. Okonkwo",
    reference: "EMP-2298",
    rows: [
      { label: "Department", value: "Operations" },
      { label: "Start date", value: "2026-08-24" },
      { label: "Onboarding", value: "4 of 9 done" },
    ],
    tone: "paper",
  },
  contractor: {
    kind: "Contractor",
    title: "S. Lindqvist",
    reference: "CTR-118",
    rows: [
      { label: "Engagement", value: "Data migration" },
      { label: "Rate", value: "92.00 / hr" },
      { label: "Ends", value: "2026-11-30" },
    ],
    tone: "paper",
  },

  /* ---- HR -------------------------------------------------------------- */
  leave_request: {
    kind: "Leave request",
    title: "M. Ferreira",
    reference: "LV-3390",
    rows: [
      { label: "Dates", value: "07 – 11 Sep" },
      { label: "Working days", value: "5" },
      { label: "Balance after", value: "12.5 days" },
    ],
    tone: "paper",
  },
  attendance: {
    kind: "Attendance",
    title: "August 2026",
    reference: "ATT-0826",
    rows: [
      { label: "Present", value: "21 days" },
      { label: "Absent", value: "1 day" },
      { label: "Overtime", value: "6.5 hrs" },
    ],
    tone: "paper",
  },
  recruitment: {
    kind: "Requisition",
    title: "Financial Analyst",
    reference: "REQ-77",
    rows: [
      { label: "Stage", value: "Interview" },
      { label: "Candidates", value: "14" },
      { label: "Hiring manager", value: "R. Haddad" },
    ],
    tone: "paper",
  },
  payroll_run: {
    kind: "Payroll run",
    title: "August 2026",
    reference: "PR-2026-08",
    rows: [
      { label: "Headcount", value: "412" },
      { label: "Gross", value: "1,884,220.00" },
      { label: "Deductions", value: "481,609.45" },
    ],
    total: { label: "Net", value: "1,402,610.55" },
    tone: "paper",
  },
  salary_change: {
    kind: "Salary change",
    title: "R. Haddad",
    reference: "EMP-1877",
    rows: [
      { label: "From", value: "68,000.00" },
      { label: "To", value: "74,500.00" },
      { label: "Effective", value: "2026-09-01" },
    ],
    tone: "paper",
  },

  /* ---- Finance --------------------------------------------------------- */
  vendor_invoice: {
    // The hero document. Scene 3 follows this one all the way through.
    kind: "Invoice",
    title: "Acme Vendor LLC",
    reference: "INV-2291",
    rows: [
      { label: "Received", value: "2026-08-11" },
      { label: "Due", value: "2026-09-10" },
      { label: "Currency", value: "USD" },
    ],
    total: { label: "Total", value: "4,200.00" },
    tone: "paper",
  },
  expense_claim: {
    kind: "Expense claim",
    title: "A. Novak",
    reference: "EXP-8821",
    rows: [
      { label: "Travel", value: "612.40" },
      { label: "Meals", value: "88.15" },
      { label: "Submitted", value: "2026-08-09" },
    ],
    total: { label: "Total", value: "700.55" },
    tone: "paper",
  },
  payment_run: {
    kind: "Payment run",
    title: "Weekly · AP",
    reference: "PMT-4402",
    rows: [
      { label: "Invoices", value: "38" },
      { label: "Value date", value: "2026-08-14" },
      { label: "Method", value: "SEPA credit" },
    ],
    total: { label: "Total", value: "214,880.00" },
    tone: "paper",
  },
  receivable: {
    kind: "Receivable",
    title: "Bellhaven Ltd",
    reference: "AR-1120",
    rows: [
      { label: "Outstanding", value: "18,400.00" },
      { label: "Overdue", value: "12 days" },
      { label: "Terms", value: "Net 30" },
    ],
    tone: "paper",
  },
  journal_entry: {
    kind: "Journal entry",
    title: "Accounts payable",
    reference: "JE-99120",
    rows: [
      { label: "Debit", value: "4,200.00" },
      { label: "Credit", value: "4,200.00" },
      { label: "Period", value: "2026-08" },
    ],
    tone: "paper",
  },

  /* ---- ERP ------------------------------------------------------------- */
  purchase_order: {
    kind: "Purchase order",
    title: "Acme Vendor LLC",
    reference: "PO-4471",
    rows: [
      { label: "Quantity", value: "120 units" },
      { label: "Unit price", value: "35.00" },
      { label: "Delivery", value: "2026-08-08" },
    ],
    total: { label: "Total", value: "4,200.00" },
    tone: "paper",
  },
  goods_receipt: {
    kind: "Goods receipt",
    title: "Against PO-4471",
    reference: "GR-2214",
    rows: [
      { label: "Expected", value: "120" },
      { label: "Received", value: "120" },
      { label: "Variance", value: "0" },
    ],
    tone: "paper",
  },
  inventory_move: {
    kind: "Inventory move",
    title: "AC-2291-B",
    reference: "MV-7781",
    rows: [
      { label: "Quantity", value: "120" },
      { label: "From", value: "DC-2 Rotterdam" },
      { label: "To", value: "DC-5 Lyon" },
    ],
    tone: "paper",
  },
  supplier: {
    kind: "Supplier",
    title: "Acme Vendor LLC",
    reference: "SUP-0442",
    rows: [
      { label: "Terms", value: "Net 30" },
      { label: "Rating", value: "A−" },
      { label: "Open orders", value: "3" },
    ],
    tone: "paper",
  },
  contract_pdf: {
    kind: "Contract",
    title: "Master services",
    reference: "MSA-2024-11",
    rows: [
      { label: "Counterparty", value: "Acme Vendor LLC" },
      { label: "Renews", value: "2027-01-01" },
      { label: "Annual value", value: "180,000.00" },
    ],
    tone: "paper",
  },

  /* ---- Approval gates -------------------------------------------------- */
  finance_approval: {
    kind: "Approval required",
    title: "Acme Vendor LLC",
    reference: "INV-2291",
    rows: [
      { label: "Requested by", value: "extract_invoice" },
      { label: "Rule", value: "total_amount > 1,000" },
      { label: "Status", value: "Waiting" },
    ],
    total: { label: "Amount", value: "4,200.00" },
    tone: "gate",
  },
  manager_approval: {
    kind: "Approval required",
    title: "Leave · M. Ferreira",
    reference: "LV-3390",
    rows: [
      { label: "Requested by", value: "leave_policy" },
      { label: "Working days", value: "5" },
      { label: "Status", value: "Waiting" },
    ],
    tone: "gate",
  },
};

/** Lookup that fails loudly. A missing card renders as a blank white slab. */
export function cardFor(nodeId: string): DocumentCard {
  const card = DOCUMENT_CARDS[nodeId];
  if (!card) throw new Error(`No document card for scene node "${nodeId}"`);
  return card;
}
