# Accounts Payable Policy

**Northwind Operations Ltd — Finance**
Document reference: FIN-AP-004
Version 6.2 · Effective 1 January 2026 · Owner: Group Financial Controller

---

## 1. Purpose and scope

This policy governs how Northwind Operations Ltd receives, validates, approves
and settles supplier invoices. It applies to every entity in the group, to every
currency, and to all supplier invoices regardless of value — including invoices
received by email, through the supplier portal, or by automated feed.

It does not cover employee expense reimbursement, which is governed separately
by the Employee Expense Reimbursement Policy (FIN-EXP-002), nor payroll
disbursement, which is governed by the Payroll Operating Procedure.

## 2. Approval thresholds

Approval authority is determined by the gross invoice total in the invoice's own
currency, converted to USD at the month-end rate where the invoice is not
denominated in USD.

| Gross invoice total (USD) | Approval required |
|---|---|
| Up to and including 1,000.00 | No individual approval. Posted automatically once the three-way match succeeds. |
| Above 1,000.00 and up to 25,000.00 | One approver from the Finance team. |
| Above 25,000.00 and up to 100,000.00 | Financial Controller. |
| Above 100,000.00 | Financial Controller and one Director. |

**Any invoice with a gross total above USD 1,000.00 requires explicit human
approval before it is posted to the general ledger.** This threshold is
deliberate and is not adjusted for individual suppliers, for recurring invoices,
or for invoices that match a purchase order exactly. An invoice that clears the
three-way match but exceeds the threshold still stops for approval.

Approval must be recorded before the journal entry is created. Posting first and
seeking approval afterwards is a control failure and must be reported to the
Financial Controller within one working day.

## 3. The three-way match

Every invoice referencing a purchase order is matched against three documents
before it may be posted:

1. The **purchase order** raised by the requesting department.
2. The **goods receipt** confirming the quantity actually delivered.
3. The **supplier invoice** itself.

The match succeeds when the vendor, the quantity and the unit price agree across
all three, and when the invoice total does not exceed the purchase order total.

A worked example. Purchase order PO-4471 was raised against Acme Vendor LLC for
120 units at a unit price of USD 35.00, giving a purchase order total of USD
4,200.00. Goods receipt GR-2214 confirmed 120 units received with a variance of
zero. Supplier invoice INV-2291 was subsequently received for USD 4,200.00. All
three agree, so the three-way match succeeds. Because the total exceeds USD
1,000.00, the invoice nevertheless requires Finance approval before journal
entry JE-99120 is created.

### Tolerances

A price variance of up to 2% or USD 50.00, whichever is lower, may be accepted
without re-raising the purchase order. A quantity variance is never tolerated:
any difference between the goods receipt and the invoiced quantity must be
resolved with the supplier before the invoice is processed.

## 4. Invoices without a purchase order

Non-PO invoices are permitted only for the categories listed in Appendix B
(utilities, statutory fees, insurance premiums and professional indemnity
renewals). A non-PO invoice in any other category is returned to the supplier.

Non-PO invoices above USD 1,000.00 require the same Finance approval as PO-backed
invoices, and additionally require the budget holder for the cost centre to
confirm the charge in writing.

## 5. Payment terms

Standard payment terms across the group are **Net 30** from the invoice date,
unless a signed master agreement specifies otherwise. Where a master services
agreement is in force, the terms in that agreement take precedence over this
policy. Suppliers may not unilaterally alter payment terms by printing different
terms on an invoice; the contracted terms govern.

Early settlement discounts are taken only where the discount exceeds the group's
cost of capital for the period saved. Finance recalculates this quarterly.

Payment runs are executed weekly. An approved invoice missing a payment run is
carried to the next run and does not require re-approval.

## 6. Account coding

Invoices are coded to the general ledger as follows:

| Category | Account code |
|---|---|
| Goods for resale | 5000 |
| Raw materials and components | 5100 |
| Subcontracted services | 6100 |
| Professional and advisory fees | 6200 |
| Software and licensing | 6300 |
| Travel and subsistence | 6400 |
| Facilities and utilities | 6500 |
| Accounts payable control | 2100 |

The corresponding credit for a supplier invoice is always account 2100, accounts
payable control. A journal entry that debits and credits the same account is
rejected by the ledger.

## 7. Duplicate invoice control

Before an invoice is posted, Finance checks for an existing entry with the same
supplier, the same invoice number, and the same gross total. A match on all three
is treated as a duplicate and is not posted.

A match on supplier and invoice number but not on total is escalated rather than
posted or rejected: it usually indicates that the supplier has reissued a
corrected invoice under the same number, which requires the original to be
credited first.

## 8. Disputed invoices

An invoice is placed in dispute when the goods or services were not received,
when the amount does not agree with the contracted price, or when the invoice
refers to a purchase order that does not exist. A disputed invoice is not posted
and does not accrue against the payment run.

Disputes must be raised with the supplier within the window specified in the
governing master agreement, or within 30 days of the invoice date where no
agreement is in force. Disputes raised after the window may leave the group
contractually liable for the full invoiced amount.

## 9. Segregation of duties

The person who raises a purchase order may not approve the corresponding
invoice. The person who approves an invoice may not release the payment. Where
team size makes this impractical, the Financial Controller must record a
compensating control in the risk register and review it quarterly.

## 10. Retention and audit

Invoices, approvals and the supporting match documents are retained for seven
years. The approval record must identify who approved, when, and what they saw at
the time of approval. An approval that cannot be reconstructed from the record is
treated as an absent approval during audit.
