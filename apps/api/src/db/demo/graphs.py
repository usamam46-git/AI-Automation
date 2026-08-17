"""
src/db/demo/graphs.py — the three flagship demo workflows, as data.

Build-plan days 10–12. These are the graphs the seed script publishes, and they
exist to exercise every subsystem the product claims in one place: signed webhook
and manual triggers, structured-output agents, registry-backed retrieval, a
structured condition, the human-approval interrupt, a mutating ERP write, and the
publish-time guardrail that ties the last two together.

## Why this is data and not a fixture JSON blob

The node `config` shapes here are the *same* shapes `_agent_config` /
`_tool_config` in `src/graphs/node_handlers.py` accept and that the Builder's
config forms construct. Keeping them as Python literals next to a docstring means
a reader can see the contract; keeping them in a JSON file means the next person
edits them blind. If either handler's accepted shape changes, this file changes
with it — the same rule apps/web/CLAUDE.md states for the config forms.

## Facts are locked to the marketing site

Every figure below belongs to the same fiction as `apps/web/lib/run-film.ts` and
`apps/web/lib/document-cards.ts`:

    PO-4471 → GR-2214 → INV-2291 (Acme Vendor LLC, 4,200.00) → JE-99120

The landing page's 3D scene renders that chain and holds it at the approval gate.
A demo whose numbers disagree with the site it is demoed next to is worse than no
demo, so if you change an amount here, change it there too.

## Three deliberate asymmetries between the workflows

1. **The invoice routes deterministically, the expense claim routes on the
   model.** `check_amount` compares `total_amount` against the policy's USD
   1,000 threshold with the structured condition DSL — it cannot misfire, and it
   is the rule the landing page prints verbatim. `check_compliance` routes on an
   agent's boolean, which is the plan's "RAG changing an outcome" claim made
   literally: the retrieved expense-policy clause is what decides the branch.
   Showing both is the point; a demo where every decision is an LLM guess is not
   a governance story.
2. **Both mutating workflows converge on the write from two branches**, one
   through the approval gate and one around it. That is Vol. 5 §1's shape and it
   is what ∃-semantics in `validate_mutating_approval` exists to permit — the
   clean branch reaches the write without its own gate. Do not "fix" this into a
   single approved path; it would delete the case the guardrail was designed for.
3. **The HR assistant has no mutating node and no gate at all.** It is the
   cheapest run in the set and the one to open a cold demo with, so it stays a
   pure retrieve-then-answer chain.

## Agent output schemas

`type` and `properties` only. `_normalize_strict_schema` in `llm_client.py`
injects `required` (every declared property) and `additionalProperties: false`,
so declaring either here is redundant at best. Optional fields are expressed as a
nullable type — `["string", "null"]` — because strict mode makes every property
required and that is the documented way to say "may be absent".
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any

#: The model every agent node in the demo set runs on.
#:
#: Plan §6: mini is the development default at $0.40/$1.60 per million, ~$0.0018
#: per RAG call. nano is cheap enough to be tempting and is not good enough at
#: the extraction step — it drops line items out of the structured output often
#: enough to make a live demo a coin flip. gpt-4.1 is ~5x mini for no visible
#: difference on documents this short.
DEMO_MODEL = "gpt-4.1-mini"

#: The AP policy's approval threshold, in USD.
#:
#: This number appears in three places that must agree: `corpus/ap-policy.md`
#: §2, the `check_amount` condition below, and the "Rule: total_amount > 1,000"
#: line on the landing page's approval card (`apps/web/lib/document-cards.ts`).
#: The condition is what actually routes; the other two explain it to a human.
APPROVAL_THRESHOLD_USD = 1000


@dataclass(frozen=True)
class DemoNode:
    node_key: str
    node_type: str
    position_x: float
    position_y: float
    config: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class DemoEdge:
    source_node_key: str
    target_node_key: str
    condition: dict[str, Any] | None = None


@dataclass(frozen=True)
class DemoWorkflow:
    #: Stable identity for the seed's idempotency check — the workflow is looked
    #: up by name within the workspace, so renaming one here creates a second
    #: workflow rather than updating the first.
    name: str
    description: str
    trigger_type: str
    nodes: list[DemoNode]
    edges: list[DemoEdge]
    trigger_config: dict[str, Any] | None = None
    #: Printed by the seed script as the thing to do next with this workflow.
    demo_hint: str = ""


# ---------------------------------------------------------------------------
# 1. Invoice approval — webhook
# ---------------------------------------------------------------------------

_EXTRACT_INVOICE_PROMPT = """\
You are an accounts payable clerk at Northwind Operations Ltd. You are given the \
raw body of an inbound invoice webhook.

Extract the invoice's fields exactly as presented. Do not calculate, correct or \
normalise figures — if the payload says 4200.00, return 4200.00. Return the \
currency as a three-letter ISO code.

For any field the payload does not contain, return null rather than guessing. An \
invented purchase order number is worse than a missing one, because the \
three-way match downstream will appear to succeed.

`line_item_summary` is one sentence a human could read instead of the line \
items: what was bought, how many, at what unit price.

`policy_question` is the single question Finance would need answered from the \
company's accounts payable policy and the supplier's master services agreement \
in order to decide whether this invoice can be paid. Write it as a natural \
question naming the vendor and the amount, because it is used verbatim as a \
semantic search query against those documents.\
"""

_VALIDATE_INVOICE_PROMPT = """\
You are an accounts payable controller at Northwind Operations Ltd.

You are given two things: the fields extracted from a supplier invoice, and \
passages retrieved from the company's own accounts payable policy and the \
signed master services agreement with the supplier. The passages are the \
authority. Do not rely on general knowledge of how accounts payable usually \
works — if the retrieved passages do not cover a point, say so in `findings` \
rather than filling the gap from memory.

Assess whether the invoice can be paid:

- `within_policy` — true only if nothing in the retrieved passages is breached.
- `approval_required_by_policy` — true if the passages require a human to \
approve an invoice of this value. State the threshold you are applying in \
`policy_citation`.
- `account_code` — the general ledger code from the policy's coding table that \
matches what was purchased. Return the code only, as a string, e.g. "5100".
- `findings` — one short line per issue found, or per check passed. Name the \
figure and the clause. Empty only if you checked nothing, which should not happen.
- `policy_citation` — quote the specific sentence you relied on most, and name \
the document it came from.
- `recommendation` — one sentence addressed to the approver: what you would do \
and why. This is the line a person reads before clicking approve.\
"""


def _invoice_workflow(*, policy_tool_id: uuid.UUID, erp_tool_id: uuid.UUID) -> DemoWorkflow:
    return DemoWorkflow(
        name="Invoice approval",
        description=(
            "A supplier invoice arrives on a signed webhook. An agent extracts its fields, retrieval "
            "grounds the check in the AP policy and the supplier's contract, and anything above the "
            "policy threshold stops at a person before the journal entry is created."
        ),
        trigger_type="webhook",
        demo_hint="Send the demo invoice: python -m src.db.demo.send_invoice",
        nodes=[
            DemoNode("start_1", "start", 0, 240),
            DemoNode(
                "extract_invoice",
                "agent",
                220,
                240,
                {
                    "model": DEMO_MODEL,
                    "system_prompt": _EXTRACT_INVOICE_PROMPT,
                    "input_fields": ["trigger_payload"],
                    "temperature": 0.0,
                    "output_schema": {
                        "type": "object",
                        "properties": {
                            "vendor_name": {"type": "string", "description": "Legal name of the supplier."},
                            "invoice_number": {"type": "string", "description": "The supplier's own invoice reference."},
                            "purchase_order_number": {"type": ["string", "null"], "description": "Referenced PO, or null."},
                            "total_amount": {"type": "number", "description": "Gross invoice total."},
                            "currency": {"type": "string", "description": "Three-letter ISO currency code."},
                            "invoice_date": {"type": ["string", "null"], "description": "ISO date on the invoice."},
                            "due_date": {"type": ["string", "null"], "description": "ISO date payment falls due."},
                            "line_item_summary": {"type": "string", "description": "One sentence describing what was purchased."},
                            "policy_question": {"type": "string", "description": "Search query for the AP policy and supplier contract."},
                        },
                    },
                },
            ),
            DemoNode(
                "policy_lookup",
                "tool",
                440,
                240,
                # Registry-backed: the knowledge base, top_k and score_floor are
                # owned by the tool row (ToolService.NODE_OVERRIDABLE_KEYS), and
                # this node overrides only where the query comes from.
                {
                    "tool_id": str(policy_tool_id),
                    "query_fields": {"query": "node_outputs.extract_invoice.policy_question"},
                },
            ),
            DemoNode(
                "validate_invoice",
                "agent",
                660,
                240,
                {
                    "model": DEMO_MODEL,
                    "system_prompt": _VALIDATE_INVOICE_PROMPT,
                    "input_fields": ["node_outputs.extract_invoice", "node_outputs.policy_lookup"],
                    "temperature": 0.0,
                    "output_schema": {
                        "type": "object",
                        "properties": {
                            "within_policy": {"type": "boolean"},
                            "approval_required_by_policy": {"type": "boolean"},
                            "account_code": {"type": "string", "description": "General ledger code from the policy's coding table."},
                            "findings": {"type": "array", "items": {"type": "string"}},
                            "policy_citation": {"type": "string"},
                            "recommendation": {"type": "string"},
                        },
                    },
                },
            ),
            DemoNode("check_amount", "condition", 880, 240),
            DemoNode("approval_1", "human_approval", 1100, 130),
            DemoNode(
                "post_to_erp",
                "tool",
                1320,
                240,
                # `is_mutating` lives on the registry row, not here. A node cannot
                # downgrade it, which is what makes the publish-time gate mean
                # something — see apps/api/CLAUDE.md's tools section.
                {
                    "tool_id": str(erp_tool_id),
                    "payload_fields": {
                        "vendor": "node_outputs.extract_invoice.vendor_name",
                        "amount": "node_outputs.extract_invoice.total_amount",
                        "account_code": "node_outputs.validate_invoice.account_code",
                        "reference": "node_outputs.extract_invoice.invoice_number",
                        "currency": "node_outputs.extract_invoice.currency",
                    },
                },
            ),
            DemoNode("end_1", "end", 1540, 240),
        ],
        edges=[
            DemoEdge("start_1", "extract_invoice"),
            DemoEdge("extract_invoice", "policy_lookup"),
            DemoEdge("policy_lookup", "validate_invoice"),
            DemoEdge("validate_invoice", "check_amount"),
            # Order matters: `_build_condition_router` returns the first branch
            # whose condition evaluates true and falls through to the LAST edge,
            # so the catch-all must be last and must carry no predicate.
            DemoEdge(
                "check_amount",
                "approval_1",
                {
                    "field": "node_outputs.extract_invoice.total_amount",
                    "operator": "gt",
                    "value": APPROVAL_THRESHOLD_USD,
                    "branch": "needs_approval",
                },
            ),
            DemoEdge("check_amount", "post_to_erp", {"branch": "auto_post"}),
            DemoEdge("approval_1", "post_to_erp"),
            DemoEdge("post_to_erp", "end_1"),
        ],
    )


# ---------------------------------------------------------------------------
# 2. Expense claim review — manual
# ---------------------------------------------------------------------------

_READ_CLAIM_PROMPT = """\
You are processing an employee expense claim at Northwind Operations Ltd.

Read the claim from the payload and return its fields as submitted. Do not \
correct arithmetic, drop lines you think look wrong, or merge lines — the \
assessment step downstream needs to see exactly what the employee submitted.

`receipt_provided` is true only where the payload says a receipt was attached. \
Absence of the field means false, not unknown: a claim line with no evidence is \
the case the policy check exists to catch.

`policy_question` is the single question you would ask of the company's expense \
reimbursement policy to decide whether this claim can be paid in full. Name the \
categories actually claimed and the amounts, because it is used verbatim as a \
semantic search query against the policy.\
"""

_ASSESS_CLAIM_PROMPT = """\
You are a finance reviewer at Northwind Operations Ltd assessing an expense claim.

You are given the claim as submitted and passages retrieved from the company's \
Employee Expense Reimbursement Policy. **The retrieved passages are the only \
authority.** Do not apply caps, deadlines or receipt thresholds from general \
knowledge — if a limit is not in the passages, you have not established it, and \
that belongs in `violations` as an item you could not check.

- `compliant` — true only if every claimed line satisfies every rule you found \
in the passages. A single breach makes this false, however small the amount. \
This field decides whether the claim goes to a human, so do not soften it.
- `violations` — one short line per breach: the claim line, the rule, and the \
figure that breaches it. Empty when `compliant` is true.
- `policy_citation` — quote the sentence you relied on most and name the \
document it came from.
- `reimbursable_amount` — the total you would actually pay, after disallowing \
anything that breaches the policy. Equal to the claim total when compliant.
- `account_code` — the general ledger code the policy assigns to employee travel \
and subsistence. Return the code only, as a string.
- `summary` — one sentence addressed to the approver, naming the decision and \
the single most important reason for it.\
"""


def _expense_workflow(*, policy_tool_id: uuid.UUID, erp_tool_id: uuid.UUID) -> DemoWorkflow:
    return DemoWorkflow(
        name="Expense claim review",
        description=(
            "An employee expense claim is read, checked against the retrieved expense policy, and "
            "routed on what the policy actually says: a clean claim is reimbursed automatically, "
            "one that breaches a clause stops for a human with the clause quoted."
        ),
        trigger_type="manual",
        demo_hint="Run now → paste the sample claim payload (printed below) into the trigger payload box.",
        nodes=[
            DemoNode("start_1", "start", 0, 240),
            DemoNode(
                "read_claim",
                "agent",
                220,
                240,
                {
                    "model": DEMO_MODEL,
                    "system_prompt": _READ_CLAIM_PROMPT,
                    "input_fields": ["trigger_payload"],
                    "temperature": 0.0,
                    "output_schema": {
                        "type": "object",
                        "properties": {
                            "claimant": {"type": "string"},
                            "claim_reference": {"type": "string"},
                            "submitted_on": {"type": ["string", "null"], "description": "ISO date the claim was submitted."},
                            "currency": {"type": "string"},
                            "total_amount": {"type": "number"},
                            "lines": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "description": {"type": "string"},
                                        "category": {"type": "string"},
                                        "amount": {"type": "number"},
                                        "incurred_on": {"type": ["string", "null"]},
                                        "receipt_provided": {"type": "boolean"},
                                    },
                                },
                            },
                            "policy_question": {"type": "string"},
                        },
                    },
                },
            ),
            DemoNode(
                "policy_lookup",
                "tool",
                440,
                240,
                {
                    "tool_id": str(policy_tool_id),
                    "query_fields": {"query": "node_outputs.read_claim.policy_question"},
                },
            ),
            DemoNode(
                "assess_claim",
                "agent",
                660,
                240,
                {
                    "model": DEMO_MODEL,
                    "system_prompt": _ASSESS_CLAIM_PROMPT,
                    "input_fields": ["node_outputs.read_claim", "node_outputs.policy_lookup"],
                    "temperature": 0.0,
                    "output_schema": {
                        "type": "object",
                        "properties": {
                            "compliant": {"type": "boolean"},
                            "violations": {"type": "array", "items": {"type": "string"}},
                            "policy_citation": {"type": "string"},
                            "reimbursable_amount": {"type": "number"},
                            "account_code": {"type": "string"},
                            "summary": {"type": "string"},
                        },
                    },
                },
            ),
            DemoNode("check_compliance", "condition", 880, 240),
            DemoNode("approval_1", "human_approval", 1100, 130),
            DemoNode(
                "record_reimbursement",
                "tool",
                1320,
                240,
                {
                    "tool_id": str(erp_tool_id),
                    "payload_fields": {
                        "vendor": "node_outputs.read_claim.claimant",
                        "amount": "node_outputs.assess_claim.reimbursable_amount",
                        "account_code": "node_outputs.assess_claim.account_code",
                        "reference": "node_outputs.read_claim.claim_reference",
                        "currency": "node_outputs.read_claim.currency",
                    },
                },
            ),
            DemoNode("end_1", "end", 1540, 240),
        ],
        edges=[
            DemoEdge("start_1", "read_claim"),
            DemoEdge("read_claim", "policy_lookup"),
            DemoEdge("policy_lookup", "assess_claim"),
            DemoEdge("assess_claim", "check_compliance"),
            DemoEdge(
                "check_compliance",
                "approval_1",
                {
                    "field": "node_outputs.assess_claim.compliant",
                    "operator": "eq",
                    "value": False,
                    "branch": "needs_review",
                },
            ),
            DemoEdge("check_compliance", "record_reimbursement", {"branch": "auto_reimburse"}),
            DemoEdge("approval_1", "record_reimbursement"),
            DemoEdge("record_reimbursement", "end_1"),
        ],
    )


# ---------------------------------------------------------------------------
# 3. HR policy assistant — manual
# ---------------------------------------------------------------------------

#: Asked when the run carries no payload, which is every "Run now" click that
#: does not open the payload box. `_run_knowledge_search` prefers a resolved
#: `query_fields` value and falls back to this static one only when the resolved
#: value is empty — so the same published node answers a typed question or this
#: one, with no second workflow.
DEFAULT_HANDBOOK_QUESTION = "How many days of annual leave do employees get, and how much may be carried into the next year?"

_ANSWER_QUESTION_PROMPT = """\
You are the HR assistant for Northwind Operations Ltd, answering an employee's \
question about company policy.

You are given the question and the passages retrieved from the employee \
handbook. **Answer only from those passages.** You know a great deal about how \
employment usually works and none of it applies here — the company's own \
handbook is the only thing that can answer a question about the company's own \
policy, and a plausible answer that is not in the handbook is the worst possible \
output of this workflow.

If the passages do not contain the answer, set `answered_from_handbook` to false \
and say plainly in `answer` that the handbook does not cover it and who to ask. \
Do not apologise at length and do not speculate about what the policy might be.

Quote figures exactly as the handbook states them, including the units. Name the \
section you drew the answer from in `source_section` — the handbook's own \
heading, not a page number.

Keep `answer` under 120 words. This is read on a screen by someone who wants a \
number.\
"""


def _hr_workflow(*, handbook_tool_id: uuid.UUID) -> DemoWorkflow:
    return DemoWorkflow(
        name="HR policy assistant",
        description=(
            "Grounded question answering over the employee handbook. No mutating step and no approval "
            "gate — the cheapest run in the set, and the one to open a cold demo with."
        ),
        trigger_type="manual",
        demo_hint='Run now works with no input. To ask your own question: {"question": "How much notice do I have to give?"}',
        nodes=[
            DemoNode("start_1", "start", 0, 200),
            DemoNode(
                "handbook_lookup",
                "tool",
                240,
                200,
                {
                    "tool_id": str(handbook_tool_id),
                    "query": DEFAULT_HANDBOOK_QUESTION,
                    "query_fields": {"query": "trigger_payload.question"},
                },
            ),
            DemoNode(
                "answer_question",
                "agent",
                500,
                200,
                {
                    "model": DEMO_MODEL,
                    "system_prompt": _ANSWER_QUESTION_PROMPT,
                    "input_fields": ["node_outputs.handbook_lookup"],
                    "temperature": 0.0,
                    "output_schema": {
                        "type": "object",
                        "properties": {
                            "question": {"type": "string", "description": "The question that was actually searched for."},
                            "answer": {"type": "string"},
                            "source_section": {"type": "string", "description": "Handbook heading the answer came from."},
                            "source_document": {"type": "string"},
                            "answered_from_handbook": {"type": "boolean"},
                        },
                    },
                },
            ),
            DemoNode("end_1", "end", 760, 200),
        ],
        edges=[
            DemoEdge("start_1", "handbook_lookup"),
            DemoEdge("handbook_lookup", "answer_question"),
            DemoEdge("answer_question", "end_1"),
        ],
    )


def build_workflows(
    *,
    policy_tool_id: uuid.UUID,
    handbook_tool_id: uuid.UUID,
    erp_tool_id: uuid.UUID,
) -> list[DemoWorkflow]:
    """
    The three demo workflows, wired to registry tools the seed script created.

    Tool ids are passed in rather than looked up here so this module stays pure —
    it has no session, touches no database, and can be imported by a test that
    only wants to assert the graph shapes.
    """
    return [
        _hr_workflow(handbook_tool_id=handbook_tool_id),
        _expense_workflow(policy_tool_id=policy_tool_id, erp_tool_id=erp_tool_id),
        _invoice_workflow(policy_tool_id=policy_tool_id, erp_tool_id=erp_tool_id),
    ]


# ---------------------------------------------------------------------------
# Sample trigger payloads
# ---------------------------------------------------------------------------

#: The invoice `send_invoice.py` signs and POSTs, and the one the landing page's
#: 3D scene renders. Deliberately raw-ish: field names a real AP feed would use,
#: not the names `extract_invoice`'s output schema declares, so the extraction
#: step is doing real work rather than copying keys across.
SAMPLE_INVOICE_PAYLOAD: dict[str, Any] = {
    "source": "supplier-portal",
    "received_at": "2026-08-11T09:14:02Z",
    "supplier": {
        "name": "Acme Vendor LLC",
        "supplier_ref": "SUP-0442",
        "terms": "Net 30",
    },
    "document": {
        "type": "invoice",
        "number": "INV-2291",
        "issued": "2026-08-11",
        "payment_due": "2026-09-10",
        "po_ref": "PO-4471",
        "goods_receipt_ref": "GR-2214",
    },
    "lines": [
        {
            "sku": "AC-2291-B",
            "description": "Component assembly, catalogue item AC-2291-B",
            "qty": 120,
            "unit_price": 35.00,
            "line_total": 4200.00,
        }
    ],
    "totals": {
        "net": 4200.00,
        "tax": 0.00,
        "gross": 4200.00,
        "ccy": "USD",
    },
}

#: An expense claim that BREACHES the policy, on purpose — three ways.
#:
#: The demo is worth nothing if the claim sails through: `check_compliance`
#: routes on `assess_claim.compliant`, so a clean claim skips the approval gate
#: and the human-in-the-loop step never appears. Each breach below is findable in
#: `corpus/expense-policy.md` and nowhere else, which is what makes the routing a
#: demonstration of retrieval rather than of the model's general knowledge:
#:
#:   - the 412.00 client dinner has no receipt      (§3, receipts at USD 25.00+)
#:   - it also includes 96.00 of alcohol with no named guests   (§7)
#:   - the 168.00 in-flight upgrade is non-reimbursable          (§8)
#:
#: Amounts echo A. Novak / EXP-8821 from `apps/web/lib/document-cards.ts`, with
#: the extra breaching lines added on top of that card's 700.55.
SAMPLE_EXPENSE_PAYLOAD: dict[str, Any] = {
    "claim_ref": "EXP-8821",
    "employee": {"name": "A. Novak", "employee_ref": "EMP-2113", "department": "Sales"},
    "submitted": "2026-08-09",
    "currency": "USD",
    "items": [
        {"date": "2026-08-04", "type": "Air travel", "detail": "Return flight, economy", "amount": 612.40, "receipt": True},
        {"date": "2026-08-04", "type": "Meals", "detail": "Breakfast, airport", "amount": 88.15, "receipt": True},
        {
            "date": "2026-08-05",
            "type": "Client entertainment",
            "detail": "Dinner, includes 96.00 wine",
            "amount": 412.00,
            "receipt": False,
        },
        {"date": "2026-08-04", "type": "Air travel", "detail": "Seat upgrade at the gate", "amount": 168.00, "receipt": True},
    ],
    "claimed_total": 1280.55,
}

#: A question the handbook genuinely answers, for the HR workflow's payload box.
SAMPLE_HR_PAYLOAD: dict[str, Any] = {"question": "How much notice do I have to give if I resign as a manager?"}
