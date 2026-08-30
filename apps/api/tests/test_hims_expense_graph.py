"""
tests/test_hims_expense_graph.py — the Afaqhims expense graph, without a database.

`src/db/hims_expense_seed.py` builds a graph that **posts to a live hospital
system**. Node `config` is `dict[str, Any]` all the way down, so nothing else in
the repo connects those hand-written blobs to the handlers and validators that
consume them — the same gap `test_demo_graphs.py` exists to close, and it matters
more here because the write is real.

No DB, no network, no OpenAI. Everything below runs the real validators over the
real graph.
"""

from __future__ import annotations

import uuid

import pytest

from src.db.hims_expense_seed import (
    _STATIC_BODY,
    MANAGER_ONLY_CEILING_PKR,
    TOOL_CREATE_EXPENSE,
    TOOL_NOTIFY,
    TOOL_POLICY_SEARCH,
    _graph,
)
from src.graphs.condition_eval import evaluate_condition
from src.modules.tools.service import ToolService
from src.modules.workflows.schemas import EdgeInput, NodeInput
from src.modules.workflows.service import (
    GraphValidationError,
    validate_graph_structure,
    validate_mutating_approval,
)

CREATE_TOOL_ID = uuid.uuid4()
POLICY_TOOL_ID = uuid.uuid4()
NOTIFY_TOOL_ID = uuid.uuid4()


@pytest.fixture
def graph() -> tuple[list[NodeInput], list[EdgeInput]]:
    nodes, edges = _graph(
        policy_tool_id=POLICY_TOOL_ID,
        create_tool_id=CREATE_TOOL_ID,
        notify_tool_id=NOTIFY_TOOL_ID,
    )
    return (
        [NodeInput(node_key=n.node_key, node_type=n.node_type, config=n.config, position_x=n.position_x, position_y=n.position_y) for n in nodes],
        [EdgeInput(source_node_key=e.source_node_key, target_node_key=e.target_node_key, condition=e.condition) for e in edges],
    )


def test_the_graph_passes_publish_time_validation(graph):
    """start/end present, no orphans, no cycles, unique node keys."""
    nodes, edges = graph
    validate_graph_structure(nodes, edges)


def test_the_mutating_write_has_an_upstream_approval(graph):
    nodes, edges = graph
    validate_mutating_approval(nodes, edges, mutating_tool_ids={CREATE_TOOL_ID})


def _without_gates(nodes, edges, removed: set[str]):
    """Delete the named gates and re-wire their branches straight to the write."""
    kept_nodes = [n for n in nodes if n.node_key not in removed]
    kept_edges = [e for e in edges if not (removed & {e.source_node_key, e.target_node_key})]
    for gate in removed:
        source = next(e.source_node_key for e in edges if e.target_node_key == gate)
        kept_edges.append(EdgeInput(source_node_key=source, target_node_key="post_expense", condition=None))
    return kept_nodes, kept_edges


def test_removing_BOTH_gates_makes_the_graph_unpublishable(graph):
    """Proves the guardrail test above is load-bearing rather than vacuous."""
    nodes, edges = graph
    kept_nodes, kept_edges = _without_gates(nodes, edges, {"approval_finance", "approval_manager"})
    with pytest.raises(GraphValidationError) as excinfo:
        validate_mutating_approval(kept_nodes, kept_edges, mutating_tool_ids={CREATE_TOOL_ID})
    assert "post_expense" in str(excinfo.value)


@pytest.mark.parametrize("removed", ["approval_finance", "approval_manager"])
def test_removing_ONE_gate_still_publishes_and_that_is_a_known_limit(graph, removed):
    """
    **This is a caveat, not a reassurance, and it is pinned so nobody assumes
    otherwise.**

    `validate_mutating_approval` is ∃-semantics by design: a mutating node passes
    if ANY `human_approval` sits in its ancestor set, even when an individual
    branch reaches it unapproved. Vol. 4 §4.3's wording is "has **no** upstream
    approval node in its dependency path", and ∀ would reject the blueprint's own
    Vol. 5 §1 and §5 reference workflows.

    The consequence here is concrete: delete either gate from this graph and it
    still publishes, while one branch posts to a **live hospital ledger**
    unattended. The publish guardrail will not catch that. What catches it is
    `test_the_mutating_write_has_an_upstream_approval` above plus this file being
    read — so if this test ever starts failing because the validator became ∀,
    delete it and celebrate.
    """
    nodes, edges = graph
    kept_nodes, kept_edges = _without_gates(nodes, edges, {removed})
    validate_mutating_approval(kept_nodes, kept_edges, mutating_tool_ids={CREATE_TOOL_ID})


def test_both_branches_are_gated_in_the_published_graph(graph):
    """
    What the ∃ validator cannot enforce, asserted directly: EVERY path from the
    condition to the write passes through a `human_approval` node.
    """
    nodes, edges = graph
    gates = {n.node_key for n in nodes if n.node_type == "human_approval"}
    into_write = {e.source_node_key for e in edges if e.target_node_key == "post_expense"}
    assert into_write, "nothing reaches post_expense"
    assert into_write <= gates, f"these reach the live write without a gate: {sorted(into_write - gates)}"


def test_the_amount_routes_on_a_number_and_never_on_the_model(graph):
    """
    The H2 lesson, pinned.

    Which gate an expense reaches must be decided by arithmetic on the extracted
    amount, not by anything the assessment agent produced. A predicate reading
    `node_outputs.assess.*` here would put the model in charge of the money.
    """
    _, edges = graph
    predicates = [e for e in edges if e.source_node_key == "check_amount" and e.condition and "field" in e.condition]
    assert len(predicates) == 1, "exactly one predicate plus one catch-all — see MANAGER_ONLY_CEILING_PKR"
    condition = predicates[0].condition
    assert condition["field"] == "node_outputs.extract.amount_pkr"
    assert condition["operator"] == "gt"
    assert condition["value"] == MANAGER_ONLY_CEILING_PKR


def test_the_threshold_actually_routes_the_way_the_policy_reads(graph):
    """Runs the real evaluator over the real condition at both sides of the band."""
    _, edges = graph
    condition = next(e.condition for e in edges if e.source_node_key == "check_amount" and e.condition and "field" in e.condition)

    def route(amount: float) -> bool:
        # Argument order is (condition, state) — reversing it makes every call
        # return True, because a state dict has no `field` and reads as a
        # catch-all. That mistake passes silently; hence the boundary cases below.
        return evaluate_condition(condition, {"node_outputs": {"extract": {"amount_pkr": amount}}})

    assert route(12_500) is True, "PKR 10,001-50,000 escalates to Finance"
    assert route(75_000) is True, "above PKR 50,000 escalates too"
    assert route(10_000) is False, "exactly the ceiling is manager-only"
    assert route(200) is False


def test_exactly_one_catch_all_leaves_the_condition(graph):
    """
    Only "the catch-all runs last" is guaranteed by the engine — `save_draft`
    re-inserts every edge in one transaction, so `created_at` ties and the
    tiebreak is a random UUID. A second predicate here would have undefined
    order relative to the first.
    """
    _, edges = graph
    leaving = [e for e in edges if e.source_node_key == "check_amount"]
    catch_alls = [e for e in leaving if not (e.condition and "field" in e.condition)]
    assert len(leaving) == 2
    assert len(catch_alls) == 1


def test_no_two_condition_nodes_are_adjacent(graph):
    """
    Condition nodes cannot chain — the router attaches to the condition's
    PREDECESSOR, so two in sequence mis-route silently and nothing validates it
    at publish. Same guard as the demo graphs carry.
    """
    nodes, edges = graph
    conditions = {n.node_key for n in nodes if n.node_type == "condition"}
    for edge in edges:
        assert not (edge.source_node_key in conditions and edge.target_node_key in conditions)


def test_the_write_node_carries_no_credential_and_cannot_repoint_the_endpoint(graph):
    """
    A node may only wire up the body. If `url`, `headers`, `method` or
    `is_mutating` ever appear here they are either ignored (and misleading) or,
    for a future reader copying this file, an invitation to put a token in
    plaintext JSONB that every read endpoint returns.
    """
    nodes, _ = graph
    config = next(n.config for n in nodes if n.node_key == "post_expense")
    assert set(config) <= {"tool_id", *ToolService.NODE_OVERRIDABLE_KEYS}
    assert "url" not in config and "headers" not in config and "is_mutating" not in config


def test_the_amount_reaches_the_api_as_a_string_and_the_router_as_a_number(graph):
    """
    Afaqhims sends `expense_amount` as a string (`"200"`), while `gt` on a string
    would compare wrongly or raise. Two representations of one value is the
    deliberate answer; this pins that neither call site drifts onto the other.
    """
    nodes, _ = graph
    body_fields = next(n.config for n in nodes if n.node_key == "post_expense")["body_fields"]
    assert body_fields["expense_amount"] == "node_outputs.extract.expense_amount"

    schema = next(n.config for n in nodes if n.node_key == "extract")["output_schema"]["properties"]
    assert schema["expense_amount"]["type"] == "string"
    assert schema["amount_pkr"]["type"] == "number"


def test_the_static_shift_constants_travel_with_the_body(graph):
    """
    Knowingly approximate — see the seed's module docstring. Pinned so that
    replacing it with a real mapping is a deliberate edit rather than a silent
    drift, and so the wrong-shift caveat cannot quietly stop being true.
    """
    nodes, _ = graph
    body = next(n.config for n in nodes if n.node_key == "post_expense")["body"]
    assert body == _STATIC_BODY
    assert body["shift_id"] == 6 and body["expense_shift"] == "Evening"


def test_retrieval_searches_on_the_decision_not_the_item_description(graph):
    """
    The other half of the H2 lesson. `tool_1` searching on a product description
    made the spend-authority table effectively unreachable; the query here is
    built by `extract` and is required to name the amount and the category.
    """
    nodes, _ = graph
    lookup = next(n.config for n in nodes if n.node_key == "policy_lookup")
    assert lookup["query_fields"] == {"query": "node_outputs.extract.policy_question"}
    # The node must not own the corpus, the depth or the floor — those are
    # registry-owned so they cannot be widened on the canvas.
    assert "knowledge_base_id" not in lookup and "score_floor" not in lookup


def test_the_notification_reports_the_unique_row_id(graph):
    """
    `expense_id` is NOT unique in HIMS — two expenses posted on 2026-08-30 came
    back as srl_no 6164 and 6165 carrying the same `expense_id` "EXP2028". A
    notification that named only `expense_id` could not identify which row it
    was about, which defeats the point of reporting it at all.
    """
    nodes, _ = graph
    body_fields = next(n.config for n in nodes if n.node_key == "notify")["body_fields"]
    assert body_fields["srl_no"] == "node_outputs.post_expense.body.data.srl_no"
    assert body_fields["expense_id"] == "node_outputs.post_expense.body.data.expense_id"


def test_every_tool_node_is_registry_backed(graph):
    """
    Inline `tool_type` always wins over `tool_id` at the backend. An inline
    config here would silently bypass the registry row that owns `is_mutating`,
    and with it the publish-time guardrail.
    """
    nodes, _ = graph
    expected = {POLICY_TOOL_ID, CREATE_TOOL_ID, NOTIFY_TOOL_ID}
    seen = set()
    for node in (n for n in nodes if n.node_type == "tool"):
        assert "tool_type" not in node.config, f"{node.node_key} carries inline config"
        seen.add(uuid.UUID(node.config["tool_id"]))
    assert seen == expected


def test_the_tool_names_the_seed_looks_up_are_the_ones_it_registers():
    """Cheap guard against a rename in one constant and not the other."""
    assert TOOL_CREATE_EXPENSE == "hims_create_expense"
    assert TOOL_POLICY_SEARCH == "expense_policy_search"
    assert TOOL_NOTIFY == "hims_notify_finance"
