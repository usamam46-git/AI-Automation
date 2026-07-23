# Volume 5 — ERP Automation
### AI Automation Platform — Engineering Blueprint, Volume 5 of 7

> This volume is the platform's strongest differentiator: fully worked, diagrammed business workflows spanning Finance, Procurement, HR, and Sales — each modeled as a real LangGraph graph using the node taxonomy from Volume 3 §4.1 and the execution semantics from Volume 4.

---

## Table of Contents

1. [Finance: Invoice Processing](#1-finance-invoice-processing)
2. [Finance: Vendor Registration](#2-finance-vendor-registration)
3. [Finance: Purchase Approval](#3-finance-purchase-approval)
4. [Finance: Expense Approval](#4-finance-expense-approval)
5. [Finance: Journal Validation](#5-finance-journal-validation)
6. [Finance: Ledger Search Assistant](#6-finance-ledger-search-assistant)
7. [Finance: Trial Balance Assistant](#7-finance-trial-balance-assistant)
8. [Finance: Bank Reconciliation Assistant](#8-finance-bank-reconciliation-assistant)
9. [Finance: Payment Approval](#9-finance-payment-approval)
10. [Finance: Financial Reporting Assistant](#10-finance-financial-reporting-assistant)
11. [Finance: Tax Validation](#11-finance-tax-validation)
12. [Finance: Budget Approval](#12-finance-budget-approval)
13. [Procurement Automation](#13-procurement-automation)
14. [HR: Leave Approval](#14-hr-leave-approval)
15. [HR: Payroll Validation](#15-hr-payroll-validation)
16. [HR: Attendance Automation](#16-hr-attendance-automation)
17. [Sales: Quotation Assistant](#17-sales-quotation-assistant)
18. [Sales: CRM Automation](#18-sales-crm-automation)
19. [Inventory Automation](#19-inventory-automation)

---

## 1. Finance: Invoice Processing

**Business context:** An AP clerk currently opens each vendor email, reads the attached PDF, keys the invoice into the ERP, checks it against a purchase order, and routes it for manager approval if it exceeds a threshold.

```mermaid
graph TD
    T([Email Trigger]) --> A[Agent: Extract Invoice<br/>vision + structured output]
    A --> B{Confidence >= 0.8<br/>AND OCR quality OK?}
    B -->|no| H1[Human Approval:<br/>Confirm extracted fields]
    B -->|yes| C[Tool: erp.get_vendor]
    H1 --> C
    C --> D{Vendor found?}
    D -->|no| H2[Human Approval:<br/>New vendor or typo?]
    D -->|yes| E[Tool: erp.get_purchase_order]
    H2 --> E
    E --> F{PO match &<br/>amount within tolerance?}
    F -->|yes, under threshold| G[Tool: erp.create_journal_entry]
    F -->|over threshold or mismatch| H3[Human Approval:<br/>Manager sign-off]
    H3 --> G
    G --> N[Tool: notify.whatsapp<br/>AP team]
    N --> Z([Archive])
```

**Node detail:**

| Node | Type | Notes |
|---|---|---|
| Extract Invoice | Agent | Vision-capable model on the PDF; returns `InvoiceExtraction` (Volume 4 §6) |
| erp.get_vendor | Tool (`erp_connector`) | Exact match on tax ID/legal name |
| erp.get_purchase_order | Tool (`erp_connector`) | Matches invoice line items against open POs, 2-way or 3-way match |
| erp.create_journal_entry | Tool (`erp_connector`) | Only reachable after all upstream approval gates |

**Exception paths modeled explicitly:** low-confidence extraction, unknown vendor, PO mismatch, and over-threshold amount each have a *distinct* human-approval node with a tailored prompt to the reviewer — a single generic "please review" step would force every reviewer to re-derive *why* the case needs attention.

---

## 2. Finance: Vendor Registration

```mermaid
graph TD
    T([Trigger: New Vendor Form]) --> A[Agent: Validate Submission<br/>completeness + format checks]
    A --> B[Tool: erp.search_vendors<br/>fuzzy dedup check]
    B --> C{Possible duplicate?}
    C -->|yes| H1[Human Approval:<br/>Confirm not a duplicate]
    C -->|no| D[Tool: verify.tax_id<br/>external registry lookup]
    H1 --> D
    D --> E{Tax ID valid?}
    E -->|no| R[Reject: notify submitter]
    E -->|yes| H2[Human Approval:<br/>Finance sign-off]
    H2 --> F[Tool: erp.create_vendor]
    F --> N[Notify: vendor + AP team]
```

**Why duplicate-detection matters:** vendor master-data duplication is one of the most common sources of duplicate payments in mid-market finance; the fuzzy-dedup tool call (name similarity + tax-ID exact match + address similarity) runs *before* any human touches the request, surfacing likely-duplicate matches directly in the approval prompt.

---

## 3. Finance: Purchase Approval

```mermaid
graph TD
    T([Trigger: Requisition Submitted]) --> A[Tool: erp.get_budget_remaining]
    A --> B{Within budget?}
    B -->|no| H1[Human Approval:<br/>Budget exception]
    B -->|yes| C{Amount > policy threshold?}
    C -->|no| D[Tool: erp.approve_requisition]
    C -->|yes| H2[Human Approval:<br/>Manager/Director tier by amount]
    H1 --> H2
    H2 --> D
    D --> N[Notify: requester]
```

**Approval-tier routing:** the platform's condition nodes implement a **tiered approval matrix** (e.g., <$1,000 auto-approved if in budget; $1,000–$10,000 manager approval; >$10,000 director approval) as a lookup against an org-configured policy table rather than hardcoded thresholds, so finance teams can adjust policy without a workflow republish.

---

## 4. Finance: Expense Approval

```mermaid
graph TD
    T([Trigger: Expense Report Submitted]) --> A[Agent: Extract Receipts<br/>OCR + categorize]
    A --> B[Tool: policy.check_compliance<br/>per-diem, category limits, receipt required]
    B --> C{Policy violations?}
    C -->|none| D[Tool: erp.approve_expense]
    C -->|minor| H1[Human Approval:<br/>Manager review w/ flagged items]
    C -->|major/suspected fraud| H2[Human Approval:<br/>Finance + Manager escalation]
    H1 --> D
    H2 --> D
    D --> N[Notify: employee + payroll]
```

**Policy-as-data:** expense policy rules (per-diem caps, category-specific limits, mandatory-receipt thresholds) are stored as structured org settings, consumed by the `policy.check_compliance` tool as deterministic code — never left to an LLM's judgment of "is this reasonable," keeping policy enforcement consistent and auditable.

---

## 5. Finance: Journal Validation

```mermaid
graph TD
    T([Trigger: Journal Entry Draft]) --> A[Tool: validate.debits_equal_credits]
    A --> B{Balanced?}
    B -->|no| R[Reject: return to preparer w/ diff]
    B -->|yes| C[Tool: validate.account_codes_exist]
    C --> D{Valid accounts?}
    D -->|no| R2[Reject: flag invalid account codes]
    D -->|yes| E[Agent: Anomaly Check<br/>vs. historical entry patterns]
    E --> F{Anomalous?}
    F -->|no| G[Tool: erp.post_journal_entry]
    F -->|yes| H1[Human Approval:<br/>Controller review]
    H1 --> G
```

**Deterministic first, agentic second:** balance-check and account-code validation are pure arithmetic/lookup (never an LLM call — there is zero ambiguity in "do debits equal credits"); only the *anomaly detection* step (comparing this entry's pattern against the account's historical entry distribution) is agentic, since that judgment genuinely benefits from pattern reasoning over historical context.

---

## 6. Finance: Ledger Search Assistant

A **chat-based** (not workflow-graph) agent (Volume 3 §9) backed by RAG over the general ledger export and a `erp_query` tool for live lookups, letting a controller ask "show me all entries to the travel expense account over $500 in Q2" in natural language rather than building a filtered report in the ERP UI. Grounding: every answer cites the specific ledger entries retrieved (Volume 4 §13), never a paraphrased summary without traceable source rows.

---

## 7. Finance: Trial Balance Assistant

```mermaid
graph TD
    T([Trigger: Month-End]) --> A[Tool: erp.get_trial_balance]
    A --> B[Agent: Flag Anomalies<br/>vs. prior period + budget]
    B --> C{Anomalies found?}
    C -->|no| D[Notify: TB ready, clean]
    C -->|yes| H1[Human Approval:<br/>Controller review w/ flagged accounts]
    H1 --> D
```

Flags: accounts with unusual period-over-period variance, accounts that should net to zero but don't, and suspense/clearing accounts with a non-zero balance past a configurable age — surfaced with the agent's reasoning attached so the controller doesn't have to re-derive *why* an account was flagged.

---

## 8. Finance: Bank Reconciliation Assistant

```mermaid
graph TD
    T([Trigger: Bank Statement Import]) --> A[Tool: parse_bank_statement]
    A --> B[Tool: erp.get_unreconciled_transactions]
    B --> C[Agent: Match Transactions<br/>fuzzy amount/date/description matching]
    C --> D{Match rate acceptable?}
    D -->|yes, all matched| E[Tool: erp.mark_reconciled]
    D -->|unmatched remain| H1[Human Approval:<br/>Review unmatched items]
    H1 --> E
    E --> N[Notify: reconciliation report]
```

The matching agent scores candidate matches (amount ± tolerance, date proximity, description similarity) and only *proposes* matches above a confidence floor automatically — items below the floor are queued for human review rather than force-matched, since an incorrect auto-reconciliation is far more costly to unwind than a manual review step.

---

## 9. Finance: Payment Approval

```mermaid
graph TD
    T([Trigger: Payment Batch Ready]) --> A[Tool: validate.duplicate_payment_check]
    A --> B{Duplicates found?}
    B -->|yes| H1[Human Approval:<br/>Confirm/remove duplicates]
    B -->|no| C[Tool: validate.vendor_bank_details]
    H1 --> C
    C --> D{Bank details recently changed?}
    D -->|yes| H2[Human Approval:<br/>Verify change via callback — fraud control]
    D -->|no| E[Human Approval:<br/>Final payment authorization]
    H2 --> E
    E --> F[Tool: erp.release_payment]
    F --> N[Notify: vendor + AP]
```

**Fraud control emphasis:** a recent change to a vendor's bank details is one of the most common vectors for payment-fraud (business email compromise); this workflow *always* forces a human verification step in that case regardless of amount, overriding the normal tiered-approval logic — a deliberate, hardcoded policy exception, not a configurable threshold.

---

## 10. Finance: Financial Reporting Assistant

A scheduled workflow that assembles a monthly management report: `erp.get_pnl`, `erp.get_balance_sheet`, and `erp.get_cash_flow` tool calls feed an agent that drafts a narrative variance commentary ("Revenue grew 8% MoM driven by..."), which is always routed through a `human_approval` node before distribution — financial narrative headed to executives/board is never auto-sent without a human sign-off, regardless of how confident the drafting agent is.

---

## 11. Finance: Tax Validation

```mermaid
graph TD
    T([Trigger: Invoice/Transaction]) --> A[Tool: tax.determine_jurisdiction]
    A --> B[Tool: tax.calculate_expected]
    B --> C{Matches invoice tax amount?}
    C -->|yes| D[Tool: erp.approve_tax_line]
    C -->|no, small variance| H1[Human Approval: Review variance]
    C -->|no, large variance| H2[Human Approval: Escalate to tax team]
    H1 --> D
    H2 --> D
```

Tax rate/jurisdiction logic is sourced from a maintained tax-rules table (not model knowledge, which can be stale or jurisdiction-ambiguous) — the agent's role is limited to jurisdiction determination from address/entity data, with the actual rate calculation performed deterministically.

---

## 12. Finance: Budget Approval

```mermaid
graph TD
    T([Trigger: Budget Request]) --> A[Tool: erp.get_department_budget_status]
    A --> B[Agent: Justification Review<br/>vs. historical spend patterns]
    B --> C{Within delegated authority?}
    C -->|yes| D[Tool: erp.approve_budget_line]
    C -->|no| H1[Human Approval: Next tier]
    H1 --> D
```

---

## 13. Procurement Automation

End-to-end chain linking **Purchase Approval (§3)** → PO issuance → **Vendor Registration (§2)** (if new vendor) → goods-receipt confirmation → **Invoice Processing (§1)** three-way match — implemented as a parent workflow that invokes the relevant workflows as **subgraphs** (Volume 4 §3), demonstrating the platform's reusable-subgraph pattern rather than duplicating logic across a monolithic "procurement" workflow.

```mermaid
graph LR
    A[Subgraph: Purchase Approval] --> B[Tool: erp.issue_po]
    B --> C{New vendor?}
    C -->|yes| D[Subgraph: Vendor Registration]
    C -->|no| E[Wait: Goods Receipt]
    D --> E
    E --> F[Subgraph: Invoice Processing<br/>3-way match against PO + receipt]
```

---

## 14. HR: Leave Approval

```mermaid
graph TD
    T([Trigger: Leave Request]) --> A[Tool: hr.get_leave_balance]
    A --> B{Sufficient balance?}
    B -->|no| H1[Human Approval: Manager — negative balance exception]
    B -->|yes| C[Tool: hr.check_team_coverage<br/>overlapping approved leave]
    C --> D{Coverage risk?}
    D -->|no| E[Tool: hr.approve_leave]
    D -->|yes| H2[Human Approval: Manager — coverage conflict]
    H1 --> E
    H2 --> E
    E --> N[Notify: employee + team calendar]
```

---

## 15. HR: Payroll Validation

```mermaid
graph TD
    T([Trigger: Payroll Run Draft]) --> A[Tool: payroll.variance_check<br/>vs. prior period per employee]
    A --> B{Variance > threshold?}
    B -->|no| C[Tool: payroll.approve_run]
    B -->|yes| D[Agent: Explain Variance<br/>new hire, raise, overtime, termination?]
    D --> H1[Human Approval: Payroll manager]
    H1 --> C
    C --> N[Notify: Finance — payroll approved for disbursement]
```

The variance-explanation agent's job is narrow and specific: attribute *why* an individual's pay changed using structured HR data (start date, comp changes, timesheet hours) — never a free-form guess, always grounded in queried records.

---

## 16. HR: Attendance Automation

```mermaid
graph TD
    T([Trigger: Daily Attendance Sync]) --> A[Tool: attendance.import_biometric_log]
    A --> B[Tool: attendance.flag_exceptions<br/>late, missing punch, unapproved absence]
    B --> C{Exceptions found?}
    C -->|no| D[Tool: attendance.finalize_day]
    C -->|yes| H1[Human Approval: Manager — resolve exceptions]
    H1 --> D
```

---

## 17. Sales: Quotation Assistant

```mermaid
graph TD
    T([Trigger: Inbound Quote Request — email/chat]) --> A[Agent: Extract Requirements<br/>products, quantities, customer]
    A --> B[Tool: crm.get_customer_pricing_tier]
    B --> C[Tool: erp.check_inventory_availability]
    C --> D[Agent: Draft Quotation]
    D --> E{Discount within delegated authority?}
    E -->|yes| F[Tool: crm.send_quotation]
    E -->|no| H1[Human Approval: Sales manager — discount exception]
    H1 --> F
    F --> N[Notify: sales rep + CRM log]
```

---

## 18. Sales: CRM Automation

Inbound emails/calls are classified (new lead, existing customer inquiry, support issue) and routed: new leads trigger `crm.create_lead` + enrichment tool calls (company size, industry) and a notification to the assigned rep; existing-customer inquiries are matched to the CRM record and logged as an activity — all deterministic CRM writes, with an agent used only for the classification and enrichment-summary steps, keeping the CRM as system-of-record integrity fully in deterministic tool code.

---

## 19. Inventory Automation

```mermaid
graph TD
    T([Trigger: Stock Level Check — scheduled]) --> A[Tool: erp.get_stock_levels]
    A --> B{Below reorder point?}
    B -->|no| Z([End])
    B -->|yes| C[Tool: erp.get_preferred_supplier]
    C --> D{Auto-reorder eligible<br/>amount, supplier, history}
    D -->|yes| E[Tool: erp.create_purchase_order]
    D -->|no| H1[Human Approval: Procurement review]
    H1 --> E
    E --> N[Notify: procurement team]
```

---

## Cross-Workflow Design Notes

- **Consistent pattern across all 19 workflows:** deterministic validation first, agentic judgment second, human approval as an explicit graph node (not an afterthought) whenever financial risk, fraud risk, or policy ambiguity is present.
- **Every workflow above is directly expressible in the visual builder** (Volume 3 §4) using only the seven node types defined in Volume 3 §4.1 — no workflow in this volume required extending the node taxonomy, validating that the taxonomy is sufficiently general for real ERP automation.
- **Reusability:** Vendor Registration, Invoice Processing, and Purchase Approval are each also invoked as subgraphs from Procurement Automation (§13), demonstrating the subgraph pattern's practical value beyond a single workflow.

---

*Continue to **Volume 6 — Deployment & Operations** for Docker topology, CI/CD, monitoring, and disaster-recovery planning.*
