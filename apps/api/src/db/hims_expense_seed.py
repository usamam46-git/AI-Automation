"""
src/db/hims_expense_seed.py — the Afaqhims expense-posting workflow, as data.

Run it:

    docker exec -w /app aap_api python -m src.db.hims_expense_seed --email you@example.com

Idempotent. Re-running with an unchanged graph publishes nothing.

## Why this is here and not in `src/db/demo/`

`demo/` is fiction — Northwind, Acme Vendor, a mock ERP returning `MOCK-<uuid>`.
This graph posts to a **real, live hospital system**, so filing it next to the
demo corpus would be actively misleading to the next reader. It sits beside
`seed_roles.py` instead, which is the existing precedent for a real seed script
in `src/db/`, and it is a single module rather than a package because it defines
one workflow.

It must live under `src/` either way: `infra/docker-compose.yml` bind-mounts
`apps/api/src` into `api` and nothing else, so a prompt edited on the host is
live in the container with no rebuild.

## The safety properties this graph relies on, in the order they matter

1. **`hims_create_expense` is `is_mutating: true` on the registry row.** That is
   what makes `validate_mutating_approval` refuse to publish this graph if the
   approval gates are ever removed — a 422 naming the node. A node cannot
   downgrade the flag, so it cannot be edited away on the canvas either.
2. **Money routes deterministically.** `check_amount` compares a real number
   against the policy's PKR 10,000 threshold through the structured condition
   DSL. The model never decides which gate an expense goes to. This is the
   lesson from `Docs/shakedown-fixes.md` §H2, where a graph that let retrieval
   confidence drive the gate auto-posted a large purchase and escalated a small
   one.
3. **Retrieval searches on the DECISION, not on the description.** `extract`
   emits a `policy_question` naming the amount and the category, and that is
   what reaches the knowledge base — not "tea allowance".
4. **The endpoint does not de-duplicate**, confirmed with the system's owner, so
   the tool carries no `idempotency` block. `_may_retry` therefore replays a
   failed POST only when the request provably never arrived. Do not add an
   `idempotency` block unless Afaqhims starts honouring the header: a key the
   server ignores looks like a guarantee and is not one.

## A null date is a POLICY violation, not an engine special case

`body_fields` resolves an unreachable path to `None` and **sends it** — unlike
`params_fields`, which drops the key. So a payload with no date produces
`"expense_date": null` in the POST body, and what a live hospital API does with
that is unknown: a 422, or worse, an undated row in a financial ledger.

The fix is not to invent a date. `extract` still returns null rather than
guessing, because a fabricated date on a financial record is worse than a
missing one, and "default it to today" is wrong whenever the expense was
incurred on any other day.

Instead `assess` is told that a missing date or amount is a **violation**, which
it is: the policy requires the date and amount on every claim, and the 15-day
submission deadline cannot be evaluated without a date. So the gap surfaces to
the reviewer as a named breach on the approval screen rather than as a quiet
`null` three fields down, and the human gate — which every path already passes
through — is what stops it. The authority stays the document.

## The one thing in here that is knowingly approximate

`shift_id` / `expense_shift` are sent as the **constants 6 / "Evening"**, the
only pair evidenced by a real request. Every expense this workflow files is
therefore stamped Evening shift regardless of when it happened. That is wrong
data, not a failure — nothing errors — so it is called out here, in
`_STATIC_BODY`, and in the seed's own output. Replace with a state-mapped field
once the full shift enum is known.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

# Registers every mapper before the first query. This is a non-FastAPI entry
# point, so nothing has transitively imported the relationship targets and
# SQLAlchemy resolves `relationship("Organization")` strings at first use —
# see apps/api/CLAUDE.md's Celery worker invariants, same trap.
import src.db.all_models  # noqa: F401  (import for side effects)
from src.db.database import AsyncSessionLocal, engine
from src.modules.audit_logs.schemas import AuditContext
from src.modules.auth.models import OrgMembership, User
from src.modules.knowledge_base.models import KnowledgeBase
from src.modules.tools.models import Tool
from src.modules.tools.schemas import ToolCreate, ToolUpdate
from src.modules.tools.service import ToolService
from src.modules.workflows.schemas import (
    EdgeInput,
    NodeInput,
    WorkflowCreate,
    WorkflowVersionCreate,
)
from src.modules.workflows.service import WorkflowService
from src.modules.workspaces.models import Workspace

# ---------------------------------------------------------------------------
# Constants that must agree with the policy document
# ---------------------------------------------------------------------------

#: Workspace and knowledge base to seed into. Both must already exist — this
#: script does not create them, because getting either wrong means building the
#: workflow against the wrong corpus and only finding out at demo time.
WORKSPACE_NAME = "HIMS"
KNOWLEDGE_BASE_NAME = "Expense Policy"

#: `Afaqhims_Expenses_Policy.pdf` §4, the approval table:
#:
#:     Up to PKR 10,000      Department Manager
#:     PKR 10,001 - 50,000   Department Manager + Finance
#:     Above PKR 50,000      Department Head + Finance, written pre-approval
#:
#: Only the FIRST boundary is a routing decision here, and that is a deliberate
#: limit of the engine rather than a simplification of the policy. The condition
#: DSL takes ONE `field`/`operator`/`value` per edge — there is no AND — so a
#: mutually exclusive middle band is not expressible in a single predicate. The
#: obvious workaround, an ordered ladder (`gt 50000` then `gt 10000`), is unsafe
#: here: `save_draft` re-inserts every edge in one transaction so `created_at`
#: ties across the whole graph and the tiebreak falls through to a random UUID.
#: Only "the catch-all runs last" is guaranteed.
#:
#: So the graph routes on one predicate plus one fallback, which IS ordered
#: deterministically, and the 10,001-50,000 versus above-50,000 distinction is
#: carried to the reviewer in `required_approval_level` instead of by routing.
#: The human at the gate is the control the policy actually specifies.
MANAGER_ONLY_CEILING_PKR = 10_000
FINANCE_ESCALATION_PKR = 50_000

#: Extraction and assessment both run on mini. Same reasoning as the demo set:
#: nano drops fields out of structured output often enough to make a live run a
#: coin flip, and 4.1 is ~5x the price for no visible difference on a payload
#: this small.
MODEL = "gpt-4.1-mini"

#: Sent verbatim on every request. See the module docstring — `shift_id` 6 is
#: the only value evidenced by a real call, and pairing it with anything but
#: "Evening" would be inventing a mapping.
_STATIC_BODY: dict[str, Any] = {"shift_id": 6, "expense_shift": "Evening"}

TOOL_POLICY_SEARCH = "expense_policy_search"
TOOL_CREATE_EXPENSE = "hims_create_expense"
TOOL_NOTIFY = "hims_notify_finance"

WORKFLOW_NAME = "HIMS expense posting"


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------


def _step(message: str) -> None:
    print(f"  · {message}")


def _done(message: str) -> None:
    print(f"  ✓ {message}")


def _warn(message: str) -> None:
    print(f"  ! {message}")


def _heading(message: str) -> None:
    print(f"\n{message}\n{'─' * len(message)}")


class SeedError(RuntimeError):
    """A precondition this script refuses to guess about."""


@dataclass(frozen=True)
class Target:
    user_id: uuid.UUID
    email: str
    organization_id: uuid.UUID
    workspace_id: uuid.UUID
    knowledge_base_id: uuid.UUID


# ---------------------------------------------------------------------------
# Graph, as data
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Node:
    node_key: str
    node_type: str
    position_x: float
    position_y: float
    config: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Edge:
    source_node_key: str
    target_node_key: str
    condition: dict[str, Any] | None = None


_EXTRACT_PROMPT = f"""\
You are a finance clerk at Afaqhims, a hospital. You are given the raw trigger \
payload for an expense that someone wants recorded in the hospital's system.

Read the payload and return its fields exactly as presented. Do not calculate, \
correct or round any figure. If the payload says 4200, return 4200.

Field rules:

- `amount_pkr` is the expense amount as a NUMBER, in Pakistani Rupees. It is \
what the approval threshold is compared against, so it must never be a string \
and must never carry a currency symbol or thousands separator.
- `expense_amount` is that same value rendered as a plain decimal STRING, \
because the hospital's API expects a string. "4200" and 4200 must always be the \
same number. Never let these two disagree.
- `expense_name` is a short label for the expense, at most 60 characters.
- `expense_description` is one sentence a person could read to understand what \
was bought and why.
- `expense_by` is the name or staff identifier of the person the expense is for.
- `expense_date` and `expense_time` are ISO date (YYYY-MM-DD) and 24-hour time \
(HH:MM:SS). If the payload gives neither, return null and the workflow will be \
held for a human rather than guessing a date onto a financial record.
- `category` is the policy category this best fits, from the policy's own list: \
Travel & Transport, Meals & Hospitality, Office & Operations, IT & Software, \
Training & Professional, Patient/Clinical Operations. Use "Uncategorised" if \
none fits.
- `policy_question` is the question Finance would need answered from the \
hospital's expense policy in order to decide whether this expense may be \
recorded. It is used verbatim as a semantic search query, so name the AMOUNT \
and the CATEGORY in it — the approval thresholds are stated per amount band, \
and a query built from the item description alone will not reach them. Write it \
as a natural question, for example: "What approval and evidence are required \
for a PKR {MANAGER_ONLY_CEILING_PKR + 5000:,} Office & Operations expense?"

For anything the payload does not contain, return null rather than inventing a \
value. A missing field stops at a human; an invented one is posted to a live \
hospital ledger.\
"""

_ASSESS_PROMPT = f"""\
You are an expense controller at Afaqhims, a hospital.

You are given the fields extracted from an expense request and passages \
retrieved from the hospital's own expense policy. **The passages are the \
authority.** Do not rely on general knowledge of how expense policies usually \
work — if the retrieved passages do not cover a point, say so in `findings` \
rather than filling the gap from memory.

Assess whether this expense may be recorded:

- `compliant` — true only if nothing in the retrieved passages is breached. A \
missing receipt, a non-reimbursable category, a stale claim date, or an expense \
that looks like a split of a larger purchase all make this false.
- **A missing expense date or amount is always a violation.** The policy \
requires the date and amount of the expense on every claim, and the submission \
deadline cannot be evaluated at all without a date. If `expense_date` or \
`expense_time` is null, say so in `violations` in plain words — the record would \
reach the hospital's ledger undated.
- `required_approval_level` — the approval this expense needs according to the \
policy's own table. Use exactly one of: "Department Manager", \
"Department Manager + Finance", "Department Head + Finance". Quote the band you \
applied in `policy_citation`. For reference the policy's boundaries are \
PKR {MANAGER_ONLY_CEILING_PKR:,} and PKR {FINANCE_ESCALATION_PKR:,}, but take \
them from the retrieved text rather than from this instruction if the two ever \
disagree — the document is the authority, not this prompt.
- `violations` — one short line per problem found, naming the figure and the \
clause. Empty if none.
- `findings` — one short line per check you performed and passed. Never empty; \
a review that lists nothing it checked is not a review.
- `policy_citation` — quote the specific sentence you relied on most, and name \
the section it came from.
- `recommendation` — one sentence addressed to the approver: what you would do \
and why. This is the line a person reads before clicking Approve on a write to \
a live hospital system, so make it the most useful sentence you can write.\
"""


def _graph(*, policy_tool_id: uuid.UUID, create_tool_id: uuid.UUID, notify_tool_id: uuid.UUID) -> tuple[list[Node], list[Edge]]:
    """
    start -> extract -> policy_lookup -> assess -> check_amount
                                                     |
                        (> 10,000) --> approval_finance --+
                        (otherwise) -> approval_manager --+--> post_expense -> notify -> end

    Both branches converge on the write, and **both pass a gate**. That is
    stricter than `validate_mutating_approval` requires — ∃-semantics would be
    satisfied by a single gate on one branch — and it is deliberate: the policy
    says every non-routine expense is approved before the purchase, and there is
    no amount below which a robot should post to a live hospital ledger
    unattended.

    The two gates are functionally identical to the engine (a gate is a gate;
    there are no approver roles yet). They are separate nodes so the run
    timeline and the audit trail record WHICH level of approval was exercised,
    which is the thing an auditor asks about afterwards.
    """
    nodes = [
        Node("start_1", "start", 0, 260),
        Node(
            "extract",
            "agent",
            220,
            260,
            {
                "model": MODEL,
                "system_prompt": _EXTRACT_PROMPT,
                "input_fields": ["trigger_payload"],
                "temperature": 0.0,
                "output_schema": {
                    "type": "object",
                    "properties": {
                        "expense_name": {"type": "string", "description": "Short label, max 60 chars."},
                        "expense_description": {"type": "string", "description": "One sentence: what and why."},
                        "amount_pkr": {"type": "number", "description": "Amount in PKR as a number. Routing compares this."},
                        "expense_amount": {"type": "string", "description": "The same amount as a plain decimal string, for the API."},
                        "expense_by": {"type": ["string", "null"], "description": "Person the expense is for."},
                        "expense_date": {"type": ["string", "null"], "description": "ISO date, YYYY-MM-DD."},
                        "expense_time": {"type": ["string", "null"], "description": "24-hour time, HH:MM:SS."},
                        "category": {"type": "string", "description": "Policy category, or Uncategorised."},
                        "policy_question": {"type": "string", "description": "Search query naming the amount and category."},
                    },
                },
            },
        ),
        Node(
            "policy_lookup",
            "tool",
            440,
            260,
            # Registry-backed. The knowledge base, top_k and score_floor are
            # owned by the tool row; this node overrides only where the query
            # comes from, which is all `NODE_OVERRIDABLE_KEYS` allows.
            {
                "tool_id": str(policy_tool_id),
                "query_fields": {"query": "node_outputs.extract.policy_question"},
            },
        ),
        Node(
            "assess",
            "agent",
            660,
            260,
            {
                "model": MODEL,
                "system_prompt": _ASSESS_PROMPT,
                "input_fields": ["node_outputs.extract", "node_outputs.policy_lookup"],
                "temperature": 0.0,
                "output_schema": {
                    "type": "object",
                    "properties": {
                        "compliant": {"type": "boolean"},
                        "required_approval_level": {"type": "string"},
                        "violations": {"type": "array", "items": {"type": "string"}},
                        "findings": {"type": "array", "items": {"type": "string"}},
                        "policy_citation": {"type": "string"},
                        "recommendation": {"type": "string"},
                    },
                },
            },
        ),
        Node("check_amount", "condition", 880, 260),
        Node("approval_finance", "human_approval", 1100, 140),
        Node("approval_manager", "human_approval", 1100, 380),
        Node(
            "post_expense",
            "tool",
            1320,
            260,
            # `is_mutating`, the URL, the method, the headers and the secret all
            # live on the registry row and cannot be overridden here. A node may
            # only wire up the body — see ToolService.NODE_OVERRIDABLE_KEYS.
            {
                "tool_id": str(create_tool_id),
                "body": dict(_STATIC_BODY),
                "body_fields": {
                    "expense_name": "node_outputs.extract.expense_name",
                    "expense_amount": "node_outputs.extract.expense_amount",
                    "expense_by": "node_outputs.extract.expense_by",
                    "expense_description": "node_outputs.extract.expense_description",
                    "expense_date": "node_outputs.extract.expense_date",
                    "expense_time": "node_outputs.extract.expense_time",
                    # The hospital's API takes shift_date as its own field. It is
                    # the expense's date, not today's — a night-shift expense
                    # filed the next morning belongs to the shift it was incurred on.
                    "shift_date": "node_outputs.extract.expense_date",
                },
            },
        ),
        Node(
            "notify",
            "tool",
            1540,
            260,
            {
                "tool_id": str(notify_tool_id),
                "title": "Expense posted to Afaqhims",
                "body_fields": {
                    # `srl_no` FIRST because it is the only value observed to be
                    # unique. Two expenses posted on 2026-08-30 came back as
                    # srl_no 6164 and 6165 with the SAME expense_id "EXP2028",
                    # so expense_id cannot be the handle that identifies a row.
                    # Both are reported: srl_no is what a query joins on,
                    # expense_id is what a person sees in the HIMS UI.
                    "srl_no": "node_outputs.post_expense.body.data.srl_no",
                    "expense_id": "node_outputs.post_expense.body.data.expense_id",
                    "amount_pkr": "node_outputs.extract.amount_pkr",
                    "expense_name": "node_outputs.extract.expense_name",
                    "approval_level": "node_outputs.assess.required_approval_level",
                },
            },
        ),
        Node("end_1", "end", 1760, 260),
    ]

    edges = [
        Edge("start_1", "extract"),
        Edge("extract", "policy_lookup"),
        Edge("policy_lookup", "assess"),
        Edge("assess", "check_amount"),
        # One predicate plus one catch-all. The catch-all is guaranteed to sort
        # last (`_ordered_condition_edges`); any SECOND predicate here would have
        # an undefined order relative to this one — see MANAGER_ONLY_CEILING_PKR.
        Edge(
            "check_amount",
            "approval_finance",
            {
                "field": "node_outputs.extract.amount_pkr",
                "operator": "gt",
                "value": MANAGER_ONLY_CEILING_PKR,
                "branch": "finance",
            },
        ),
        Edge("check_amount", "approval_manager", {"branch": "manager"}),
        Edge("approval_finance", "post_expense"),
        Edge("approval_manager", "post_expense"),
        Edge("post_expense", "notify"),
        Edge("notify", "end_1"),
    ]
    return nodes, edges


#: A payload shaped like the one a real `POST /api/expenses` carried, for the
#: builder's Run-now box. Deliberately above the PKR 10,000 boundary so a test
#: run exercises the finance branch; drop the amount to see the manager branch.
SAMPLE_PAYLOAD: dict[str, Any] = {
    "expense_name": "Ward stationery restock",
    "expense_amount": "12500",
    "expense_by": "automation",
    "expense_description": "Printer paper and patient file folders for Ward B, receipt attached.",
    "expense_date": "2026-08-30",
    "expense_time": "16:35:40",
    "receipt_attached": True,
    "department": "Ward B",
}


# ---------------------------------------------------------------------------
# Seeding
# ---------------------------------------------------------------------------


async def _resolve_target(db: AsyncSession, email: str) -> Target:
    """
    Resolve org, the HIMS workspace and the Expense Policy KB from an email.

    Every ambiguity is a hard failure. Seeding a live-system workflow into the
    wrong workspace is not visibly wrong until it runs.
    """
    user = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
    if user is None:
        raise SeedError(f"No user with email {email!r}. Register in the app first, then re-run with that address.")

    memberships = (await db.execute(select(OrgMembership).where(OrgMembership.user_id == user.id, OrgMembership.status == "active"))).scalars().all()
    if not memberships:
        raise SeedError(f"{email} has no active organization membership.")
    if len(memberships) > 1:
        raise SeedError(
            f"{email} is an active member of {len(memberships)} organizations; this script will not guess. "
            f"Org ids: {[str(m.organization_id) for m in memberships]}."
        )
    organization_id = memberships[0].organization_id

    workspace = (
        await db.execute(select(Workspace).where(Workspace.organization_id == organization_id, Workspace.name == WORKSPACE_NAME))
    ).scalar_one_or_none()
    if workspace is None:
        raise SeedError(f"No workspace named {WORKSPACE_NAME!r} in that organization. Create it in the app first.")

    kb = (
        await db.execute(
            select(KnowledgeBase).where(
                KnowledgeBase.organization_id == organization_id,
                KnowledgeBase.workspace_id == workspace.id,
                KnowledgeBase.name == KNOWLEDGE_BASE_NAME,
            )
        )
    ).scalar_one_or_none()
    if kb is None:
        raise SeedError(f"No knowledge base named {KNOWLEDGE_BASE_NAME!r} in the {WORKSPACE_NAME} workspace. Create it and upload the policy first.")

    return Target(
        user_id=user.id,
        email=email,
        organization_id=organization_id,
        workspace_id=workspace.id,
        knowledge_base_id=kb.id,
    )


def _tool_specs(target: Target) -> list[ToolCreate]:
    """
    The registry rows this graph needs, minus `hims_create_expense`.

    That one is NOT created here on purpose — it holds an encrypted credential
    that only its owner can enter, and `secrets` is write-only with no read-back.
    A script that created it would either have to carry a live production token
    in the repository or create a tool that 401s. It is looked up and verified
    instead; see `_verify_create_expense_tool`.
    """
    return [
        ToolCreate(
            workspace_id=target.workspace_id,
            name=TOOL_POLICY_SEARCH,
            tool_type="knowledge_search",
            description=(
                "Search the Afaqhims expense policy for the clause governing a specific expense: approval "
                "thresholds, required evidence, non-reimbursable categories and claim deadlines."
            ),
            is_mutating=False,
            config={
                "knowledge_base_id": str(target.knowledge_base_id),
                # 4, not 8. The policy re-chunked to 11 sections of ~130 tokens
                # on 2026-08-30, so four hits is roughly one and a half of the
                # old chunks — enough to carry the threshold table, the
                # non-reimbursable list and the claim deadline together.
                "top_k": 4,
                # The measured floor for this corpus. After re-chunking, the
                # weakest correct hit across an eight-query probe scored 0.404
                # and the strongest wrong one sat well below; 0.3 keeps a margin
                # without admitting noise. Re-measure in the retrieval
                # playground if the policy is replaced.
                "score_floor": 0.3,
                # A registry knowledge_search row must carry a default query:
                # `_knowledge_search_config` refuses a config with neither
                # `query` nor `query_fields`. The node overrides it.
                "query": "What approval and evidence are required for this expense?",
            },
        ),
        ToolCreate(
            workspace_id=target.workspace_id,
            name=TOOL_NOTIFY,
            tool_type="notify",
            description="Tell Finance that an expense was posted to Afaqhims, with the returned expense id.",
            is_mutating=False,
            config={
                # in_app because no Slack/Teams webhook URL has been supplied.
                # Point this at one (channel `webhook`, `url` on this row, its
                # token in the row's `secrets`) and this graph starts posting
                # there with no node edited — the registry owns the transport.
                "channel": "in_app",
                "title": "Expense posted to Afaqhims",
                "body": "An expense was approved and recorded in the hospital system.",
            },
        ),
    ]


async def _verify_create_expense_tool(db: AsyncSession, target: Target) -> uuid.UUID:
    """
    Find `hims_create_expense` and refuse to build the graph on a broken one.

    Four checks, each of which has a real failure behind it rather than being
    defensive padding:

    - **Missing** — the graph cannot be built, and creating it here would mean
      shipping a production token in the repo.
    - **Not mutating** — the publish-time guardrail reads this flag. With it
      false the graph publishes happily and a write to a live hospital system is
      no longer protected by anything.
    - **A literal credential in `headers`** — `tools.config` is plaintext JSONB
      returned by every read endpoint. This was the real state of the row on
      2026-08-30: the token was in `secrets` AND copied verbatim into the
      Authorization header. Only the placeholder form is encrypted at rest.
    - **An `idempotency` block** — the endpoint does not de-duplicate, so this
      would re-enable retries on an unknown outcome and can post the same
      expense more than once.
    """
    tool = (
        await db.execute(
            select(Tool).where(
                Tool.organization_id == target.organization_id,
                Tool.workspace_id == target.workspace_id,
                Tool.name == TOOL_CREATE_EXPENSE,
                Tool.is_active.is_(True),
            )
        )
    ).scalar_one_or_none()

    if tool is None:
        raise SeedError(
            f"No active tool named {TOOL_CREATE_EXPENSE!r} in the {WORKSPACE_NAME} workspace.\n"
            "     Create it in the app (Tools -> New tool, type 'HTTP request') with:\n"
            "       url     https://api.afaqhims.com/api/expenses\n"
            "       method  POST\n"
            "       headers Authorization: Bearer {{secrets.hims_token}}\n"
            "               Content-Type: application/json\n"
            "               Accept: application/json\n"
            "       secret  hims_token = <the API token>\n"
            "       'Writes to an external system' ON, de-duplication OFF.\n"
            "     It is not created here because `secrets` is write-only and a seed script\n"
            "     must not carry a live production credential."
        )

    config = tool.config or {}
    problems: list[str] = []

    if not tool.is_mutating:
        problems.append(
            "it is not marked as writing to an external system, so publishing this graph would "
            "no longer require an approval gate in front of a live hospital write"
        )

    headers = config.get("headers") or {}
    for name, value in headers.items():
        if (
            isinstance(value, str)
            and "{{secrets." not in value
            and any(marker in name.lower() for marker in ("authorization", "api-key", "apikey", "token"))
        ):
            problems.append(
                f"header {name!r} holds a literal credential. `tools.config` is plaintext and is returned "
                "by every read endpoint — move the value into the tool's Secrets and reference it as "
                "{{secrets.<name>}}"
            )

    if config.get("idempotency") is not None:
        problems.append(
            "it declares an `idempotency` header, which asserts the endpoint de-duplicates replays. "
            "Afaqhims does not, and that assertion re-enables retrying a write whose outcome is unknown"
        )

    if problems:
        raise SeedError(f"Tool {TOOL_CREATE_EXPENSE!r} is not safe to build on:\n" + "\n".join(f"       - {p}" for p in problems))

    _done(f"tool '{TOOL_CREATE_EXPENSE}' verified (mutating, credential in secrets, no idempotency claim)")
    return tool.id


async def _ensure_tools(db: AsyncSession, target: Target) -> dict[str, uuid.UUID]:
    service = ToolService(db)
    existing = {t.name: t for t in await service.list_tools(target.organization_id, target.workspace_id, None, None, 200)}
    resolved: dict[str, uuid.UUID] = {}

    for spec in _tool_specs(target):
        current = existing.get(spec.name)
        if current is None:
            tool = await service.create_tool(target.organization_id, spec)
            await db.commit()
            resolved[spec.name] = tool.id
            _done(f"tool '{spec.name}' registered ({spec.tool_type})")
            continue

        # `tool_type` is create-only (ToolUpdate forbids it), and `secrets` is
        # deliberately never sent — a PATCH carrying it REPLACES the whole map.
        if current.config != spec.config or current.description != spec.description:
            await service.update_tool(
                target.organization_id,
                current.id,
                ToolUpdate(description=spec.description, config=spec.config, is_mutating=spec.is_mutating),
            )
            await db.commit()
            _done(f"tool '{spec.name}' updated")
        else:
            _step(f"tool '{spec.name}' already correct")
        resolved[spec.name] = current.id

    resolved[TOOL_CREATE_EXPENSE] = await _verify_create_expense_tool(db, target)
    return resolved


def _graph_signature(nodes: list[NodeInput], edges: list[EdgeInput]) -> str:
    """Order-independent fingerprint, so a re-run publishes nothing unchanged."""
    node_repr = sorted(json.dumps({"k": n.node_key, "t": n.node_type, "c": n.config}, sort_keys=True) for n in nodes)
    edge_repr = sorted(json.dumps({"s": e.source_node_key, "t": e.target_node_key, "c": e.condition}, sort_keys=True) for e in edges)
    return json.dumps({"nodes": node_repr, "edges": edge_repr}, sort_keys=True)


async def _ensure_workflow(db: AsyncSession, target: Target, tools: dict[str, uuid.UUID]) -> uuid.UUID:
    service = WorkflowService(db)
    context = AuditContext.for_user(target.user_id)

    raw_nodes, raw_edges = _graph(
        policy_tool_id=tools[TOOL_POLICY_SEARCH],
        create_tool_id=tools[TOOL_CREATE_EXPENSE],
        notify_tool_id=tools[TOOL_NOTIFY],
    )
    nodes = [
        NodeInput(node_key=n.node_key, node_type=n.node_type, config=n.config, position_x=n.position_x, position_y=n.position_y) for n in raw_nodes
    ]
    edges = [EdgeInput(source_node_key=e.source_node_key, target_node_key=e.target_node_key, condition=e.condition) for e in raw_edges]
    desired = _graph_signature(nodes, edges)

    existing = await service.list_workflows(target.organization_id, target.workspace_id, None, None, 200)
    workflow = next((w for w in existing if w.name == WORKFLOW_NAME), None)

    if workflow is None:
        workflow = await service.create_workflow(
            target.organization_id,
            WorkflowCreate(
                name=WORKFLOW_NAME,
                description=(
                    "An expense request is read, checked against the Afaqhims expense policy, and held for a "
                    "person before it is written to the hospital's live expense API."
                ),
                workspace_id=target.workspace_id,
                trigger_type="manual",
            ),
        )
        await db.commit()
        _done(f"workflow '{WORKFLOW_NAME}' created (manual trigger)")

    if workflow.current_version_id is not None:
        current = await service.get_version(target.organization_id, workflow.id, workflow.current_version_id)
        current_nodes = [
            NodeInput(node_key=n.node_key, node_type=n.node_type, config=n.config or {}, position_x=n.position_x or 0, position_y=n.position_y or 0)
            for n in current.nodes
        ]
        current_edges = [
            EdgeInput(source_node_key=e.source_node_key, target_node_key=e.target_node_key, condition=e.condition) for e in current.edges
        ]
        if _graph_signature(current_nodes, current_edges) == desired:
            _step(f"workflow '{WORKFLOW_NAME}' is already published with this graph (v{current.version_number})")
            return workflow.id

    version = await service.save_draft(target.organization_id, workflow.id, WorkflowVersionCreate(nodes=nodes, edges=edges), target.user_id)
    await db.commit()
    published = await service.publish_version(target.organization_id, workflow.id, version.id, target.user_id, context)
    await db.commit()
    _done(f"workflow '{WORKFLOW_NAME}' published as v{published.version_number}")
    return workflow.id


async def _seed(email: str) -> None:
    async with AsyncSessionLocal() as db:
        _heading("Target")
        target = await _resolve_target(db, email)
        _done(f"org {target.organization_id} · workspace '{WORKSPACE_NAME}' · KB '{KNOWLEDGE_BASE_NAME}'")

        _heading("Tools")
        tools = await _ensure_tools(db, target)

        _heading("Workflow")
        workflow_id = await _ensure_workflow(db, target, tools)

    _heading("Next")
    print(f"  Open the builder:  /workflows/{workflow_id}/builder")
    print("  Test it WITHOUT touching Afaqhims — Test step, stopping at a gate:")
    print("      the run is refused if a mutating node is in the executed prefix,")
    print("      so stop at 'approval_finance' and the POST never happens.")
    print("\n  Sample trigger payload for the Run-now box:\n")
    print("    " + json.dumps(SAMPLE_PAYLOAD, indent=2).replace("\n", "\n    "))
    _warn(
        f"shift_id is hard-coded to {_STATIC_BODY['shift_id']} / {_STATIC_BODY['expense_shift']!r} — every expense this files is stamped Evening shift."
    )
    _warn("The first run past a gate writes to the LIVE hospital API. Point the tool at a request bin first if you want to see the body.")


async def _run(email: str) -> None:
    # Dispose inside the same loop: asyncpg connections are bound to the loop
    # that opened them, and a dispose from a fresh `asyncio.run` floods the exit
    # with "Event loop is closed". Same fix as `workers/async_bridge.py`.
    try:
        await _seed(email)
    finally:
        await engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed the Afaqhims expense-posting workflow.")
    parser.add_argument("--email", required=True, help="Email of a user whose organization to seed into.")
    args = parser.parse_args()

    try:
        asyncio.run(_run(args.email))
    except SeedError as exc:
        print(f"\n  ✗ {exc}\n", file=sys.stderr)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
