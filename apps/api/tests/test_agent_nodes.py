"""
tests/test_agent_nodes.py — Integration tests for real agent-node execution.

Covers the path that was a NodeNotImplementedError stub until now: an `agent`
node compiled into a LangGraph StateGraph, invoked for real, producing a
structured result plus persisted token/cost usage.

Separate from test_executions.py on purpose: that file owns the run-lifecycle
domain (trigger → interrupt → approve/reject), this one owns agent-node
execution.

The OpenAI SDK is patched at `src.core.llm_client.OpenAI` in every test that
reaches the network boundary — no test here makes a real API call or spends
credit. `settings.OPENAI_API_KEY` is monkeypatched too, so these pass on a
machine with no key configured.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest
from httpx import AsyncClient
from test_executions import _load_run_with_executions, _load_version

from src.core import llm_client as llm_client_module
from src.graphs.compiler import compile_for_test_run, initial_state_from_trigger, run_graph_sync
from src.graphs.node_handlers import AgentNodeConfigError
from src.modules.workflows.models import WorkflowEdge, WorkflowNode, WorkflowVersion
from src.workers.graph_tasks import _stream_graph

# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

AGENT_CONFIG: dict[str, Any] = {
    "model": "gpt-4.1-mini",
    "temperature": 0.0,
    "system_prompt": "Extract the invoice fields from the payload.",
    "input_fields": ["trigger_payload"],
    "output_schema": {
        "type": "object",
        "properties": {
            "vendor_name": {"type": "string"},
            "amount": {"type": "number"},
            "confidence": {"type": "number"},
        },
    },
}

EXTRACTION = {"vendor_name": "Acme Corp", "amount": 1250.50, "confidence": 0.93}


def _fake_completion(payload: dict[str, Any], *, prompt: int = 1200, completion: int = 300) -> SimpleNamespace:
    message = SimpleNamespace(content=json.dumps(payload), refusal=None, parsed=None)
    return SimpleNamespace(
        choices=[SimpleNamespace(message=message)],
        model="gpt-4.1-mini",
        usage=SimpleNamespace(
            prompt_tokens=prompt,
            completion_tokens=completion,
            prompt_tokens_details=SimpleNamespace(cached_tokens=0),
        ),
    )


def _patched_openai(payload: dict[str, Any] = EXTRACTION):
    """Patch the SDK boundary so agent_handler runs end-to-end without a network call."""
    mock = patch("src.core.llm_client.OpenAI")
    mock_openai = mock.start()
    mock_openai.return_value.chat.completions.create.return_value = _fake_completion(payload)
    return mock, mock_openai


def _node(key: str, node_type: str, config: dict | None = None) -> WorkflowNode:
    return WorkflowNode(
        id=uuid.uuid4(),
        workflow_version_id=uuid.uuid4(),
        node_key=key,
        node_type=node_type,
        config=config or {},
        position_x=0.0,
        position_y=0.0,
    )


def _edge(source: str, target: str, condition: dict | None = None) -> WorkflowEdge:
    return WorkflowEdge(
        id=uuid.uuid4(),
        workflow_version_id=uuid.uuid4(),
        source_node_key=source,
        target_node_key=target,
        condition=condition,
    )


def _in_memory_version(nodes: list[WorkflowNode], edges: list[WorkflowEdge]) -> WorkflowVersion:
    version = WorkflowVersion(
        id=uuid.uuid4(),
        workflow_id=uuid.uuid4(),
        version_number=1,
        graph_definition={"nodes": [], "edges": []},
        published_at=datetime.now(UTC),
    )
    version.nodes = nodes
    version.edges = edges
    return version


async def _publish_agent_workflow(client: AsyncClient, tag: str, agent_config: dict[str, Any]) -> dict[str, Any]:
    """Register a user and publish a start → extract(agent) → end workflow."""
    from test_workflow_versions import create_workflow, create_workspace, graph_payload, register_and_get_token

    from src.modules.workflows.schemas import EdgeInput, NodeInput, NodeType

    data = await register_and_get_token(client, f"agentnode-{tag}")
    token = data["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    ws = await create_workspace(client, token)
    wf = await create_workflow(client, token, ws["id"])

    nodes = [
        NodeInput(node_key="start", node_type=NodeType.start, config={}, position_x=0, position_y=0),
        NodeInput(node_key="extract", node_type=NodeType.agent, config=agent_config, position_x=100, position_y=0),
        NodeInput(node_key="end", node_type=NodeType.end, config={}, position_x=200, position_y=0),
    ]
    edges = [
        EdgeInput(source_node_key="start", target_node_key="extract"),
        EdgeInput(source_node_key="extract", target_node_key="end"),
    ]

    saved = await client.post(f"/api/v1/workflows/{wf['id']}/versions", json=graph_payload(nodes, edges), headers=headers)
    assert saved.status_code == 201
    version_id = saved.json()["id"]

    published = await client.post(f"/api/v1/workflows/{wf['id']}/versions/{version_id}/publish", headers=headers)
    assert published.status_code == 200

    return {"headers": headers, "workflow_id": wf["id"], "version_id": version_id}


# ---------------------------------------------------------------------------
# Full execution through the real engine
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_agent_node_runs_and_persists_tokens_and_cost(client: AsyncClient, monkeypatch):
    """
    The headline test: a published agent workflow runs to completion through
    _stream_graph, the structured result lands in node_outputs[node_key], and
    node_executions gets non-null tokens_prompt / tokens_completion / cost_usd.
    """
    monkeypatch.setattr(llm_client_module.settings, "OPENAI_API_KEY", "sk-test")

    ctx = await _publish_agent_workflow(client, "run", AGENT_CONFIG)
    headers = ctx["headers"]

    resp = await client.post(
        f"/api/v1/workflows/{ctx['workflow_id']}/run",
        json={"trigger_payload": {"document": "invoice.pdf"}},
        headers=headers,
    )
    assert resp.status_code == 201
    run_data = resp.json()
    run_id = uuid.UUID(run_data["id"])

    version = await _load_version(ctx["version_id"])
    org_id = uuid.UUID(run_data["organization_id"])
    initial_state = initial_state_from_trigger(
        organization_id=org_id,
        trigger_payload={"document": "invoice.pdf"},
        run_id=str(run_id),
    )

    mock, mock_openai = _patched_openai()
    try:
        await _stream_graph(run_id, version, initial_state, attempt=1, organization_id=org_id)
    finally:
        mock.stop()

    # The SDK was actually exercised, with our system prompt and strict schema.
    create_kwargs = mock_openai.return_value.chat.completions.create.call_args.kwargs
    assert create_kwargs["model"] == "gpt-4.1-mini"
    assert create_kwargs["messages"][0] == {"role": "system", "content": AGENT_CONFIG["system_prompt"]}
    assert json.loads(create_kwargs["messages"][1]["content"]) == {"trigger_payload": {"document": "invoice.pdf"}}
    assert create_kwargs["response_format"]["json_schema"]["strict"] is True

    run = await _load_run_with_executions(run_id)
    assert run.status == "completed"

    executions = {ne.node_key: ne for ne in run.node_executions}
    assert "extract" in executions

    extract_exec = executions["extract"]
    assert extract_exec.status == "succeeded"

    # The structured result reached node_outputs under the node's own key.
    assert extract_exec.output["node_outputs"]["extract"] == EXTRACTION

    # Bookkeeping is persisted to its columns, not duplicated into the snapshot.
    assert "node_usage" not in extract_exec.output
    assert extract_exec.tokens_prompt == 1200
    assert extract_exec.tokens_completion == 300
    # 1200 * 0.40/1e6 + 300 * 1.60/1e6 = 0.00048 + 0.00048
    assert float(extract_exec.cost_usd) == pytest.approx(0.00096)

    # Non-LLM nodes leave the columns NULL rather than writing zeros.
    assert executions["start"].tokens_prompt is None
    assert executions["start"].cost_usd is None

    # The run-level total was incremented from the node's cost.
    assert float(run.total_cost_usd) == pytest.approx(0.00096)


@pytest.mark.asyncio
async def test_agent_cost_and_tokens_exposed_over_http(client: AsyncClient, monkeypatch):
    """NodeExecutionResponse has always exposed these fields; now they are non-null."""
    monkeypatch.setattr(llm_client_module.settings, "OPENAI_API_KEY", "sk-test")

    ctx = await _publish_agent_workflow(client, "http", AGENT_CONFIG)
    headers = ctx["headers"]

    resp = await client.post(
        f"/api/v1/workflows/{ctx['workflow_id']}/run",
        json={"trigger_payload": {"document": "x.pdf"}},
        headers=headers,
    )
    run_data = resp.json()
    run_id = uuid.UUID(run_data["id"])

    version = await _load_version(ctx["version_id"])
    org_id = uuid.UUID(run_data["organization_id"])
    state = initial_state_from_trigger(
        organization_id=org_id,
        trigger_payload={"document": "x.pdf"},
        run_id=str(run_id),
    )

    mock, _ = _patched_openai()
    try:
        await _stream_graph(run_id, version, state, attempt=1, organization_id=org_id)
    finally:
        mock.stop()

    detail = await client.get(f"/api/v1/executions/{run_id}", headers=headers)
    assert detail.status_code == 200
    body = detail.json()

    extract = next(ne for ne in body["node_executions"] if ne["node_key"] == "extract")
    assert extract["tokens_prompt"] == 1200
    assert extract["tokens_completion"] == 300
    assert extract["cost_usd"] is not None
    assert float(extract["cost_usd"]) > 0


# ---------------------------------------------------------------------------
# Agent output drives conditional routing
# ---------------------------------------------------------------------------


def test_agent_output_is_addressable_by_the_condition_dsl(monkeypatch):
    """
    The reason the parsed result is written directly to node_outputs[node_key]
    rather than nested under a wrapper: edge conditions address it as
    `node_outputs.extract.confidence`. Low confidence must route to review.
    """
    monkeypatch.setattr(llm_client_module.settings, "OPENAI_API_KEY", "sk-test")

    version = _in_memory_version(
        nodes=[
            _node("start", "start"),
            _node("extract", "agent", AGENT_CONFIG),
            _node("confidence_check", "condition"),
            _node("review", "human_approval"),
            _node("end", "end"),
        ],
        edges=[
            _edge("start", "extract"),
            _edge("extract", "confidence_check"),
            _edge("confidence_check", "review", {"field": "node_outputs.extract.confidence", "operator": "lt", "value": 0.8, "branch": "low"}),
            _edge("confidence_check", "end", {"field": "node_outputs.extract.confidence", "operator": "gte", "value": 0.8, "branch": "high"}),
            _edge("review", "end"),
        ],
    )

    compiled = compile_for_test_run(version)
    state = initial_state_from_trigger(organization_id=uuid.uuid4(), trigger_payload={"document": "blurry.pdf"})

    mock, _ = _patched_openai({"vendor_name": "Acme", "amount": 10.0, "confidence": 0.42})
    try:
        run_graph_sync(compiled, state, thread_id="low-confidence")
        snapshot = compiled.get_state({"configurable": {"thread_id": "low-confidence"}})
    finally:
        mock.stop()

    # confidence 0.42 < 0.8 → routed to the human_approval branch, which interrupts.
    assert snapshot.next == ("review",)
    assert snapshot.values["node_outputs"]["extract"]["confidence"] == 0.42


def test_agent_usage_accumulates_into_current_cost_usd(monkeypatch):
    monkeypatch.setattr(llm_client_module.settings, "OPENAI_API_KEY", "sk-test")

    version = _in_memory_version(
        nodes=[_node("start", "start"), _node("extract", "agent", AGENT_CONFIG), _node("end", "end")],
        edges=[_edge("start", "extract"), _edge("extract", "end")],
    )
    compiled = compile_for_test_run(version)
    state = initial_state_from_trigger(organization_id=uuid.uuid4(), trigger_payload={"doc": "a.pdf"})

    mock, _ = _patched_openai()
    try:
        result = run_graph_sync(compiled, state, thread_id="cost-accum")
    finally:
        mock.stop()

    assert result["current_cost_usd"] == pytest.approx(0.00096)
    assert result["node_usage"]["extract"]["tokens_prompt"] == 1200
    assert result["node_usage"]["extract"]["model"] == "gpt-4.1-mini"


def test_agent_input_fields_select_only_declared_state(monkeypatch):
    """Vol. 4 §11.2 — the prompt carries only the fields the node asked for."""
    monkeypatch.setattr(llm_client_module.settings, "OPENAI_API_KEY", "sk-test")

    config = {**AGENT_CONFIG, "input_fields": ["trigger_payload.invoice_id"]}
    version = _in_memory_version(
        nodes=[_node("start", "start"), _node("extract", "agent", config), _node("end", "end")],
        edges=[_edge("start", "extract"), _edge("extract", "end")],
    )
    compiled = compile_for_test_run(version)
    state = initial_state_from_trigger(
        organization_id=uuid.uuid4(),
        trigger_payload={"invoice_id": "INV-42", "secret_unrelated_field": "should-not-be-sent"},
    )

    mock, mock_openai = _patched_openai()
    try:
        run_graph_sync(compiled, state, thread_id="input-fields")
    finally:
        mock.stop()

    user_content = mock_openai.return_value.chat.completions.create.call_args.kwargs["messages"][1]["content"]
    assert json.loads(user_content) == {"trigger_payload.invoice_id": "INV-42"}
    assert "should-not-be-sent" not in user_content


# ---------------------------------------------------------------------------
# Config validation
# ---------------------------------------------------------------------------


def test_agent_node_without_output_schema_raises_config_error():
    version = _in_memory_version(
        nodes=[_node("start", "start"), _node("extract", "agent", {"system_prompt": "hi"}), _node("end", "end")],
        edges=[_edge("start", "extract"), _edge("extract", "end")],
    )
    compiled = compile_for_test_run(version)
    state = initial_state_from_trigger(organization_id=uuid.uuid4())

    with pytest.raises(AgentNodeConfigError, match="output_schema"):
        run_graph_sync(compiled, state, thread_id="no-schema")


def test_agent_node_with_malformed_input_fields_raises_config_error():
    config = {**AGENT_CONFIG, "input_fields": "trigger_payload"}  # str, not list
    version = _in_memory_version(
        nodes=[_node("start", "start"), _node("extract", "agent", config), _node("end", "end")],
        edges=[_edge("start", "extract"), _edge("extract", "end")],
    )
    compiled = compile_for_test_run(version)
    state = initial_state_from_trigger(organization_id=uuid.uuid4())

    with pytest.raises(AgentNodeConfigError, match="input_fields"):
        run_graph_sync(compiled, state, thread_id="bad-input-fields")


def test_config_error_message_calls_out_agent_id_only_config():
    """The common authoring mistake deserves a message that names the cause."""
    version = _in_memory_version(
        nodes=[_node("start", "start"), _node("extract", "agent", {"agent_id": str(uuid.uuid4())}), _node("end", "end")],
        edges=[_edge("start", "extract"), _edge("extract", "end")],
    )
    compiled = compile_for_test_run(version)
    state = initial_state_from_trigger(organization_id=uuid.uuid4())

    with pytest.raises(AgentNodeConfigError, match="agents module is not implemented yet"):
        run_graph_sync(compiled, state, thread_id="agent-id-only")
