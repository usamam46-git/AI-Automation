"""
tests/test_demo_graphs.py — the seeded demo workflows must stay publishable.

Build-plan days 10-12. `src/db/demo/graphs.py` hand-writes node `config` blobs in
exactly the shapes `_agent_config` and `_tool_config` accept, and edge conditions
in the shape the compiler's router evaluates. Nothing in the type system connects
the two: a config is `dict[str, Any]` all the way down, so a renamed key in
`node_handlers.py` breaks the demo silently and the failure surfaces as a 422 at
seed time, or worse, as a run that dies at its third node in front of an
audience.

These tests close that gap by running the demo graphs through **the real
validators** — the same functions `publish_version` calls — with no database, no
network and no OpenAI key. They are fast, and they fail the moment either side of
the contract moves.

The registry merge is reproduced rather than mocked away, because the demo's tool
nodes carry only a `tool_id` and their overrides: `_tool_config` on a raw demo
node would (correctly) reject it for having no `tool_type`. What must be valid is
the *merged* config, which is what actually reaches the handler at run time.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest

from src.db.demo.graphs import (
    APPROVAL_THRESHOLD_USD,
    DEMO_MODEL,
    SAMPLE_EXPENSE_PAYLOAD,
    SAMPLE_INVOICE_PAYLOAD,
    DemoWorkflow,
    build_workflows,
)
from src.db.demo.seed import _to_inputs, _tool_specs
from src.graphs.condition_eval import SUPPORTED_OPERATORS, evaluate_condition
from src.graphs.node_handlers import _agent_config, _tool_config
from src.modules.tools.service import ToolService
from src.modules.workflows.service import validate_graph_structure, validate_mutating_approval

# Stable stand-ins for rows the seed creates in the database. The ids only have
# to be internally consistent — nothing here talks to Postgres.
POLICY_TOOL_ID = uuid.UUID("11111111-1111-4111-8111-111111111111")
HANDBOOK_TOOL_ID = uuid.UUID("22222222-2222-4222-8222-222222222222")
ERP_TOOL_ID = uuid.UUID("33333333-3333-4333-8333-333333333333")
NOTIFY_TOOL_ID = uuid.UUID("66666666-6666-4666-8666-666666666666")
FINANCE_KB_ID = uuid.UUID("44444444-4444-4444-8444-444444444444")
HANDBOOK_KB_ID = uuid.UUID("55555555-5555-4555-8555-555555555555")

TOOL_IDS_BY_NAME = {
    "finance_policy_search": POLICY_TOOL_ID,
    "handbook_search": HANDBOOK_TOOL_ID,
    "erp_create_journal_entry": ERP_TOOL_ID,
    "hr_notify_employee": NOTIFY_TOOL_ID,
}


@pytest.fixture(scope="module")
def workflows() -> list[DemoWorkflow]:
    return build_workflows(
        policy_tool_id=POLICY_TOOL_ID,
        handbook_tool_id=HANDBOOK_TOOL_ID,
        erp_tool_id=ERP_TOOL_ID,
        notify_tool_id=NOTIFY_TOOL_ID,
    )


@pytest.fixture(scope="module")
def registry() -> dict[uuid.UUID, dict[str, Any]]:
    """The tool rows the seed registers, keyed by id."""
    rows: dict[uuid.UUID, dict[str, Any]] = {}
    for spec in _tool_specs(FINANCE_KB_ID, HANDBOOK_KB_ID):
        rows[TOOL_IDS_BY_NAME[spec.name]] = {
            "name": spec.name,
            "tool_type": spec.tool_type,
            "is_mutating": spec.is_mutating,
            "config": spec.config or {},
        }
    return rows


def _merge_registry_config(node_config: dict[str, Any], row: dict[str, Any], tool_id: uuid.UUID) -> dict[str, Any]:
    """
    Reproduce `ToolService.resolve_node_configs`' merge for one node.

    Deliberately reads `ToolService.NODE_OVERRIDABLE_KEYS` rather than restating
    the set: if that list changes, this test must follow it automatically rather
    than keep asserting against a stale copy.
    """
    overrides = {k: v for k, v in node_config.items() if k in ToolService.NODE_OVERRIDABLE_KEYS}
    return {**row["config"], "tool_type": row["tool_type"], "is_mutating": row["is_mutating"], "tool_id": str(tool_id), **overrides}


def _by_name(workflows: list[DemoWorkflow], name: str) -> DemoWorkflow:
    return next(w for w in workflows if w.name == name)


# ---------------------------------------------------------------------------
# Structure
# ---------------------------------------------------------------------------


def test_every_demo_graph_passes_publish_time_validation(workflows):
    """The full publish gate: start/end, no orphans, no cycles, unique keys."""
    for spec in workflows:
        nodes, edges = _to_inputs(spec)
        validate_graph_structure(nodes, edges)  # raises GraphValidationError on failure


def test_every_mutating_node_has_an_upstream_approval(workflows, registry):
    """
    The guardrail must pass for all three, and it must pass *because of the
    registry flag* — no demo node carries an inline `is_mutating`, so if
    `mutating_tool_ids` were dropped this would still pass vacuously. The
    companion test below is what makes this one meaningful.
    """
    mutating = {tool_id for tool_id, row in registry.items() if row["is_mutating"]}
    for spec in workflows:
        nodes, edges = _to_inputs(spec)
        validate_mutating_approval(nodes, edges, mutating_tool_ids=mutating)


def test_removing_the_approval_node_makes_the_invoice_graph_unpublishable(workflows, registry):
    """
    Proves the previous test is load-bearing rather than vacuous.

    This is the exact failure the demo exists to show: a graph that reaches a
    registry-mutating tool with no human_approval in its ancestor set is rejected
    at publish, naming the node.
    """
    from src.modules.workflows.service import GraphValidationError

    mutating = {tool_id for tool_id, row in registry.items() if row["is_mutating"]}
    nodes, edges = _to_inputs(_by_name(workflows, "Invoice approval"))
    nodes = [n for n in nodes if n.node_key != "approval_1"]
    edges = [e for e in edges if "approval_1" not in (e.source_node_key, e.target_node_key)]

    with pytest.raises(GraphValidationError) as excinfo:
        validate_mutating_approval(nodes, edges, mutating_tool_ids=mutating)
    assert "post_to_erp" in str(excinfo.value)


def test_the_hr_workflow_has_no_mutating_node_and_no_gate(workflows):
    """It is the cheap opener; adding a write to it would change what it is for."""
    spec = _by_name(workflows, "HR policy assistant")
    assert not any(n.node_type == "human_approval" for n in spec.nodes)
    assert not any((n.config or {}).get("tool_id") == str(ERP_TOOL_ID) for n in spec.nodes)


# ---------------------------------------------------------------------------
# Node configs — the contract with node_handlers.py
# ---------------------------------------------------------------------------


def test_every_agent_node_config_is_accepted_by_the_real_validator(workflows):
    for spec in workflows:
        for node in spec.nodes:
            if node.node_type != "agent":
                continue
            cfg = _agent_config(node.config, node.node_key)
            assert cfg["model"] == DEMO_MODEL, f"{spec.name}/{node.node_key} is not on the budgeted model"
            assert cfg["output_schema"]["type"] == "object"


def test_agent_output_schemas_declare_no_required_or_additional_properties(workflows):
    """
    `_normalize_strict_schema` injects both, on every nested object. Declaring
    them here would be redundant at best and contradictory at worst — a hand
    written `required` list that omits a property is silently overwritten, which
    reads as if optionality were supported when it is not.
    """

    def walk(schema: dict[str, Any], path: str) -> None:
        assert "required" not in schema, f"{path} declares 'required'"
        assert "additionalProperties" not in schema, f"{path} declares 'additionalProperties'"
        for key, value in (schema.get("properties") or {}).items():
            if isinstance(value, dict):
                walk(value, f"{path}.{key}")
        items = schema.get("items")
        if isinstance(items, dict):
            walk(items, f"{path}[]")

    for spec in workflows:
        for node in spec.nodes:
            if node.node_type == "agent":
                walk(node.config["output_schema"], f"{spec.name}/{node.node_key}")


def test_every_tool_node_resolves_and_its_merged_config_is_valid(workflows, registry):
    """
    Each tool node references a tool the seed actually registers, and the merged
    config `tool_handler` will receive is one `_tool_config` accepts.
    """
    for spec in workflows:
        for node in spec.nodes:
            if node.node_type != "tool":
                continue
            raw_id = (node.config or {}).get("tool_id")
            assert raw_id, f"{spec.name}/{node.node_key} has no tool_id"
            tool_id = uuid.UUID(raw_id)
            assert tool_id in registry, f"{spec.name}/{node.node_key} references an unregistered tool"

            merged = _merge_registry_config(node.config, registry[tool_id], tool_id)
            _tool_config(merged, node.node_key)  # raises ToolNodeConfigError on failure


def test_tool_nodes_override_only_what_the_registry_permits(workflows):
    """
    A demo node must not try to set `url`, `action`, `knowledge_base_id` or
    `is_mutating`. Those are registry-owned; a node setting one is silently
    dropped by the merge, so the graph would read as doing something it does not.
    """
    allowed = ToolService.NODE_OVERRIDABLE_KEYS | {"tool_id"}
    for spec in workflows:
        for node in spec.nodes:
            if node.node_type != "tool":
                continue
            stray = set(node.config or {}) - allowed
            assert not stray, f"{spec.name}/{node.node_key} sets registry-owned key(s) {sorted(stray)}"


def test_the_erp_tool_is_the_only_mutating_one(registry):
    mutating = sorted(row["name"] for row in registry.values() if row["is_mutating"])
    assert mutating == ["erp_create_journal_entry"]


def test_retrieval_tools_are_never_mutating(registry):
    """`_tool_config` rejects `is_mutating` on knowledge_search outright — a read
    that forces an approval gate upstream devalues the gate."""
    for row in registry.values():
        if row["tool_type"] == "knowledge_search":
            assert row["is_mutating"] is False


def test_registry_retrieval_rows_carry_a_default_query(registry):
    """`_knowledge_search_config` refuses a config with neither `query` nor
    `query_fields`, and the fields live on the node, not the row."""
    for row in registry.values():
        if row["tool_type"] == "knowledge_search":
            assert row["config"].get("query", "").strip(), f"{row['name']} has no default query"


# ---------------------------------------------------------------------------
# Conditions — the routing contract with the compiler
# ---------------------------------------------------------------------------


def _condition_nodes(spec: DemoWorkflow) -> list[str]:
    return [n.node_key for n in spec.nodes if n.node_type == "condition"]


def test_condition_edges_use_supported_operators(workflows):
    for spec in workflows:
        for edge in spec.edges:
            operator = (edge.condition or {}).get("operator")
            if operator is not None:
                assert operator in SUPPORTED_OPERATORS, f"{spec.name}: {operator}"


def test_every_condition_node_ends_with_an_unconditional_catch_all(workflows):
    """
    `_build_condition_router` returns the first branch whose condition evaluates
    true and otherwise falls through to the LAST outgoing edge. A predicate on
    that last edge is therefore never consulted, so a graph whose catch-all is
    not last routes somewhere its author did not intend.
    """
    for spec in workflows:
        for key in _condition_nodes(spec):
            outgoing = [e for e in spec.edges if e.source_node_key == key]
            assert len(outgoing) >= 2, f"{spec.name}/{key} has fewer than two branches"
            last = outgoing[-1].condition or {}
            assert "operator" not in last, f"{spec.name}/{key}'s last branch carries a predicate"
            for edge in outgoing[:-1]:
                assert (edge.condition or {}).get("operator"), f"{spec.name}/{key} has a non-final branch with no predicate"


def test_the_invoice_threshold_matches_the_documented_constant(workflows):
    """
    The USD 1,000 figure lives in three places that must agree: the AP policy
    corpus, this condition, and the landing page's approval card. The condition
    is the one that actually routes.
    """
    spec = _by_name(workflows, "Invoice approval")
    gate = next(e for e in spec.edges if e.source_node_key == "check_amount" and e.target_node_key == "approval_1")
    assert gate.condition["value"] == APPROVAL_THRESHOLD_USD == 1000
    assert gate.condition["operator"] == "gt"
    assert gate.condition["field"] == "node_outputs.extract_invoice.total_amount"


def test_the_sample_invoice_routes_to_the_approval_gate(workflows):
    """
    The demo's own payload must take the branch the demo is about. INV-2291 is
    USD 4,200, so a run of it that auto-posted would silently remove the human
    approval step from the flagship demo.
    """
    spec = _by_name(workflows, "Invoice approval")
    gate = next(e for e in spec.edges if e.target_node_key == "approval_1")
    state = {"node_outputs": {"extract_invoice": {"total_amount": SAMPLE_INVOICE_PAYLOAD["totals"]["gross"]}}}
    assert evaluate_condition(gate.condition, state) is True

    # ...and a small invoice must not, or the auto-post branch is dead code.
    small = {"node_outputs": {"extract_invoice": {"total_amount": 42.0}}}
    assert evaluate_condition(gate.condition, small) is False


def test_the_sample_expense_claim_is_deliberately_non_compliant(workflows):
    """
    The expense demo routes on `assess_claim.compliant`, so a clean sample claim
    would skip the gate entirely and the workflow would demonstrate nothing. The
    payload must therefore contain at least one line the policy rejects — here, a
    line above the USD 25.00 receipt threshold with no receipt.
    """
    unreceipted = [item for item in SAMPLE_EXPENSE_PAYLOAD["items"] if not item["receipt"] and item["amount"] >= 25.00]
    assert unreceipted, "the sample claim no longer breaches the receipt rule"

    spec = _by_name(workflows, "Expense claim review")
    gate = next(e for e in spec.edges if e.target_node_key == "approval_1")
    assert evaluate_condition(gate.condition, {"node_outputs": {"assess_claim": {"compliant": False}}}) is True
    assert evaluate_condition(gate.condition, {"node_outputs": {"assess_claim": {"compliant": True}}}) is False


# ---------------------------------------------------------------------------
# Triggers
# ---------------------------------------------------------------------------


def test_the_invoice_workflow_is_webhook_triggered(workflows):
    """
    Manual "Run now" sends an empty trigger_payload, so a manual invoice workflow
    has nothing to extract from and the agent invents a document. This is the
    reason `send_invoice.py` exists.
    """
    assert _by_name(workflows, "Invoice approval").trigger_type == "webhook"


def test_demo_trigger_types_are_all_implemented(workflows):
    """`email` and `event` are 422 at write time — a seed using one would fail."""
    from src.modules.workflows.service import IMPLEMENTED_TRIGGER_TYPES

    for spec in workflows:
        assert spec.trigger_type in IMPLEMENTED_TRIGGER_TYPES, spec.name


def test_workflow_names_are_unique(workflows):
    """The seed's idempotency is keyed on name within a workspace; two workflows
    sharing one would make each run overwrite the other's graph."""
    names = [w.name for w in workflows]
    assert len(names) == len(set(names))


# ---------------------------------------------------------------------------
# Leave approval — Vol. 5 §14 (2026-08-23)
# ---------------------------------------------------------------------------


def _leave(workflows: list[DemoWorkflow]) -> DemoWorkflow:
    return next(w for w in workflows if w.name == "Leave approval")


def test_leave_approval_has_two_independent_gates_converging_on_one_outcome(workflows):
    """
    §14's actual subject: a negative balance and a coverage/notice exception are
    separate reasons to involve a manager, and both land on the same outcome.
    Collapsing them into one gate would delete the shape the workflow exists to
    demonstrate.
    """
    spec = _leave(workflows)
    approvals = [n.node_key for n in spec.nodes if n.node_type == "human_approval"]
    assert sorted(approvals) == ["approval_balance", "approval_coverage"]

    targets = {(e.source_node_key, e.target_node_key) for e in spec.edges}
    assert ("approval_balance", "handbook_lookup") in targets
    assert ("approval_coverage", "notify_employee") in targets
    # Each gate is reachable AND bypassable — the ∃-semantics shape.
    assert ("check_balance", "handbook_lookup") in targets
    assert ("check_coverage", "notify_employee") in targets


def test_no_two_condition_nodes_are_adjacent_in_any_demo_graph(workflows):
    """
    Condition nodes cannot chain — `_build_condition_router` attaches to the
    condition's PREDECESSOR, so a condition feeding a condition mis-routes
    silently. Nothing validates this at publish (Docs/shakedown-fixes.md §K), so
    it is asserted here for every demo graph rather than only for the new one.
    """
    for spec in workflows:
        conditions = {n.node_key for n in spec.nodes if n.node_type == "condition"}
        for edge in spec.edges:
            assert not (
                edge.source_node_key in conditions and edge.target_node_key in conditions
            ), f"{spec.name}: {edge.source_node_key} -> {edge.target_node_key} chains two conditions"


def test_the_balance_gate_routes_deterministically_not_on_a_model_boolean(workflows):
    """
    Whether leave takes someone past their entitlement is arithmetic, and the
    same asymmetry the invoice workflow draws: numbers route on the DSL, policy
    judgement routes on a grounded agent.
    """
    spec = _leave(workflows)
    edge = next(e for e in spec.edges if e.target_node_key == "approval_balance")
    assert edge.condition == {
        "field": "node_outputs.read_request.balance_after",
        "operator": "lt",
        "value": 0,
        "branch": "negative_balance",
    }


def test_the_leave_workflow_writes_to_no_external_system(workflows):
    """
    The honest state, pinned so it cannot drift silently: §14's `hr.approve_leave`
    has no endpoint behind it here, so the graph decides and notifies. If a
    mutating HR write is ever added, this test fails — and at that point
    `validate_mutating_approval` starts requiring the gates this graph already
    has, which is the moment to update it deliberately.
    """
    spec = _leave(workflows)
    assert not any((n.config or {}).get("tool_id") == str(ERP_TOOL_ID) for n in spec.nodes)
    assert all(not (n.config or {}).get("is_mutating") for n in spec.nodes)


def test_the_notify_node_carries_a_title_and_real_state_paths(workflows):
    """
    `notify` refuses a config with no title, no body and no body_fields — a
    notification nobody can read is worse than none, because it looks delivered.
    """
    spec = _leave(workflows)
    node = next(n for n in spec.nodes if n.node_key == "notify_employee")
    assert node.config["title"]
    assert node.config["body_fields"]
    for path in node.config["body_fields"].values():
        root = path.split(".")[1]
        assert root in {n.node_key for n in spec.nodes}, f"{path} points at no node in the graph"
