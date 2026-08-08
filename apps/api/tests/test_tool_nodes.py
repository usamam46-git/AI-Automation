"""
tests/test_tool_nodes.py — Unit and integration tests for real tool-node execution.

Covers the path that was a NodeNotImplementedError stub until now: a `tool` node
compiled into a LangGraph StateGraph and invoked for real, for both tool types
implemented so far (Vol. 2 §7.2) — `http_request` and the mock `erp_connector`.

Separate from test_agent_nodes.py on the same principle that file states: it owns
agent-node execution, this one owns tool-node execution.

httpx is patched at `src.graphs.node_handlers.httpx.Client` in every test that
reaches the network boundary — no test here makes a real outbound request.
`erp_connector` never makes one by design, and one test pins that.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import httpx
import pytest
from httpx import AsyncClient
from test_executions import _load_run_with_executions, _load_version

from src.core import llm_client as llm_client_module
from src.graphs.compiler import compile_for_test_run, initial_state_from_trigger, run_graph_sync
from src.graphs.node_handlers import (
    ToolAuthenticationError,
    ToolExecutionError,
    ToolNodeConfigError,
    tool_handler,
)
from src.modules.workflows.models import WorkflowEdge, WorkflowNode, WorkflowVersion
from src.workers.graph_tasks import _stream_graph

# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

HTTP_CONFIG: dict[str, Any] = {
    "tool_type": "http_request",
    "method": "POST",
    "url": "https://erp.example.com/api/vendors",
    "headers": {"Authorization": "Bearer super-secret-token"},
    "body": {"source": "automation"},
    "body_fields": {"vendor": "node_outputs.extract.vendor_name"},
    "timeout_seconds": 15,
}

ERP_CONFIG: dict[str, Any] = {
    "tool_type": "erp_connector",
    "action": "create_journal_entry",
    "is_mutating": True,
    "payload": {"account_code": "5000"},
    "payload_fields": {
        "vendor": "node_outputs.extract.vendor_name",
        "amount": "node_outputs.extract.amount",
    },
}

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

EXTRACTION = {"vendor_name": "Acme Corp", "amount": 1250.50, "confidence": 0.42}

STATE: dict[str, Any] = {"node_outputs": {"extract": EXTRACTION}}


def _patched_httpx(*results: Any):
    """
    Patch the httpx boundary so http_request tool nodes run without a network call.

    Each positional arg is either an httpx.Response to return or an exception to
    raise, consumed one per attempt — which is what makes retry sequences testable.
    """
    mock = patch("src.graphs.node_handlers.httpx.Client")
    mock_client = mock.start()
    mock_client.return_value.request.side_effect = list(results)
    return mock, mock_client


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


def _run_tool(config: dict[str, Any], state: dict[str, Any] | None = None, **kwargs: Any) -> dict[str, Any]:
    """Invoke tool_handler directly and return just this node's output."""
    result = tool_handler(state if state is not None else STATE, node_key="call_erp", config=config, retry_base_delay=0.0, **kwargs)
    return result["node_outputs"]["call_erp"]


# ---------------------------------------------------------------------------
# http_request — happy path and state resolution
# ---------------------------------------------------------------------------


def test_http_request_tool_calls_the_configured_endpoint():
    mock, mock_client = _patched_httpx(httpx.Response(200, json={"vendor_id": "V-1"}))
    try:
        output = _run_tool(HTTP_CONFIG)
    finally:
        mock.stop()

    call = mock_client.return_value.request.call_args
    assert call.args == ("POST", "https://erp.example.com/api/vendors")
    assert call.kwargs["headers"] == {"Authorization": "Bearer super-secret-token"}
    assert mock_client.call_args.kwargs["timeout"] == 15.0

    assert output == {"status_code": 200, "body": {"vendor_id": "V-1"}}


def test_http_request_body_fields_resolve_from_state():
    """Static `body` and dotted-path `body_fields` merge, with resolved values winning."""
    mock, mock_client = _patched_httpx(httpx.Response(200, json={}))
    try:
        _run_tool(HTTP_CONFIG)
    finally:
        mock.stop()

    assert mock_client.return_value.request.call_args.kwargs["json"] == {
        "source": "automation",
        "vendor": "Acme Corp",
    }


def test_http_request_non_json_response_falls_back_to_text():
    mock, _ = _patched_httpx(httpx.Response(200, text="plain body"))
    try:
        output = _run_tool(HTTP_CONFIG)
    finally:
        mock.stop()

    assert output == {"status_code": 200, "body": "plain body"}


# ---------------------------------------------------------------------------
# http_request — retry behaviour (mirrors LLMClient's, Vol. 2 §14)
# ---------------------------------------------------------------------------


def test_http_request_retries_on_server_error_then_succeeds():
    mock, mock_client = _patched_httpx(
        httpx.Response(503),
        httpx.Response(200, json={"ok": True}),
    )
    try:
        output = _run_tool(HTTP_CONFIG)
    finally:
        mock.stop()

    assert mock_client.return_value.request.call_count == 2
    assert output["status_code"] == 200


def test_http_request_retries_on_connect_error_then_succeeds():
    mock, mock_client = _patched_httpx(
        httpx.ConnectError("connection refused"),
        httpx.Response(200, json={"ok": True}),
    )
    try:
        output = _run_tool(HTTP_CONFIG)
    finally:
        mock.stop()

    assert mock_client.return_value.request.call_count == 2
    assert output["status_code"] == 200


def test_http_request_retries_on_429():
    mock, mock_client = _patched_httpx(
        httpx.Response(429),
        httpx.Response(200, json={"ok": True}),
    )
    try:
        _run_tool(HTTP_CONFIG)
    finally:
        mock.stop()

    assert mock_client.return_value.request.call_count == 2


def test_http_request_raises_after_exhausting_retries():
    mock, mock_client = _patched_httpx(*[httpx.Response(500) for _ in range(3)])
    try:
        with pytest.raises(ToolExecutionError, match="after 3 attempts"):
            _run_tool(HTTP_CONFIG)
    finally:
        mock.stop()

    assert mock_client.return_value.request.call_count == 3


def test_http_request_backoff_delays_double_between_attempts():
    """Same 1s/2s shape as LLMClient — and no sleep after the final failed attempt."""
    mock, _ = _patched_httpx(*[httpx.TimeoutException("timed out") for _ in range(3)])
    with patch("src.graphs.node_handlers.time.sleep") as mock_sleep:
        try:
            with pytest.raises(ToolExecutionError):
                tool_handler(STATE, node_key="call_erp", config=HTTP_CONFIG, max_attempts=3, retry_base_delay=1.0)
        finally:
            mock.stop()

    assert [call.args[0] for call in mock_sleep.call_args_list] == [1.0, 2.0]


def test_http_request_closes_the_client_even_when_the_call_fails():
    mock, mock_client = _patched_httpx(*[httpx.ConnectError("nope") for _ in range(3)])
    try:
        with pytest.raises(ToolExecutionError):
            _run_tool(HTTP_CONFIG)
    finally:
        mock.stop()

    mock_client.return_value.close.assert_called_once()


# ---------------------------------------------------------------------------
# http_request — status classification (business 4xx vs credential failure)
# ---------------------------------------------------------------------------


def test_http_request_business_4xx_is_returned_as_node_output():
    """
    A 404 is a definitive answer, not a failure: Vol. 5 §1 routes on exactly this
    ("vendor found?" after erp.get_vendor), so it must reach the condition DSL as
    data rather than killing the run.
    """
    mock, mock_client = _patched_httpx(httpx.Response(404, json={"error": "not found"}))
    try:
        output = _run_tool(HTTP_CONFIG)
    finally:
        mock.stop()

    assert output == {"status_code": 404, "body": {"error": "not found"}}
    assert mock_client.return_value.request.call_count == 1  # not retried


@pytest.mark.parametrize("status_code", [401, 403])
def test_http_request_auth_failure_raises_and_is_not_retried(status_code):
    """
    A credential rejection must NOT be returned as node output: it would be
    indistinguishable from a business 404 and would silently route the graph down a
    "not found" branch. Mirrors LLMClient letting AuthenticationError surface on the
    first attempt (test_llm_client.test_auth_error_is_not_retried).
    """
    mock, mock_client = _patched_httpx(httpx.Response(status_code))
    try:
        with pytest.raises(ToolAuthenticationError, match="credential problem"):
            _run_tool(HTTP_CONFIG)
    finally:
        mock.stop()

    assert mock_client.return_value.request.call_count == 1


# ---------------------------------------------------------------------------
# http_request — credential containment
# ---------------------------------------------------------------------------


def test_http_request_output_never_includes_headers():
    """
    Pins a security guarantee, not just current behaviour: this value lands in
    node_executions.output, which the Execution Viewer renders. Request headers
    routinely carry a bearer token or API key (apps/api CLAUDE.md: never log or
    return raw secrets).
    """
    mock, _ = _patched_httpx(httpx.Response(200, json={"ok": True}, headers={"Set-Cookie": "session=leaky"}))
    try:
        output = _run_tool(HTTP_CONFIG)
    finally:
        mock.stop()

    assert set(output) == {"status_code", "body"}
    assert "super-secret-token" not in json.dumps(output)
    assert "leaky" not in json.dumps(output)


def test_tool_error_messages_redact_url_query_strings():
    """
    Tool errors land in workflow_runs.error, and `?api_key=...` is a common auth
    pattern — the query string must not survive into the message.
    """
    config = {**HTTP_CONFIG, "url": "https://erp.example.com/api/vendors?api_key=super-secret-key"}

    mock, _ = _patched_httpx(*[httpx.Response(500) for _ in range(3)])
    try:
        with pytest.raises(ToolExecutionError) as exc:
            _run_tool(config)
    finally:
        mock.stop()

    assert "super-secret-key" not in str(exc.value)
    assert "?<redacted>" in str(exc.value)


# ---------------------------------------------------------------------------
# erp_connector (mock)
# ---------------------------------------------------------------------------


def test_erp_connector_returns_mock_confirmation():
    output = _run_tool(ERP_CONFIG)

    assert output["posted"] is True
    assert output["confirmation_id"].startswith("MOCK-")
    assert output["action"] == "create_journal_entry"
    # The resolved payload is echoed as the audit record of what would have posted.
    assert output["payload"] == {"account_code": "5000", "vendor": "Acme Corp", "amount": 1250.50}


@pytest.mark.parametrize("action", ["create_journal_entry", "post_journal_entry"])
def test_erp_connector_accepts_both_blueprint_spellings(action):
    """
    Vol. 2 §7.2's ERPConnector interface and Vol. 5 §1 say `create_journal_entry`;
    Vol. 5 §5's diagram says `post_journal_entry`. Both blueprint workflows must be
    buildable verbatim, and the configured spelling is echoed back unchanged.
    """
    output = _run_tool({**ERP_CONFIG, "action": action})

    assert output["posted"] is True
    assert output["action"] == action


def test_erp_connector_makes_no_network_call():
    """The mock connector is mock all the way down — it must not touch httpx."""
    with patch("src.graphs.node_handlers.httpx.Client") as mock_client:
        output = _run_tool(ERP_CONFIG)

    mock_client.assert_not_called()
    assert output["posted"] is True


def test_erp_connector_missing_required_payload_field_raises():
    config = {**ERP_CONFIG, "payload": {}, "payload_fields": {"vendor": "node_outputs.extract.vendor_name"}}

    with pytest.raises(ToolNodeConfigError, match="missing required payload field"):
        _run_tool(config)


def test_erp_connector_unresolvable_payload_field_raises():
    """A dotted path that resolves to None is treated as missing, not as a null post."""
    config = {**ERP_CONFIG, "payload_fields": {**ERP_CONFIG["payload_fields"], "amount": "node_outputs.extract.nope"}}

    with pytest.raises(ToolNodeConfigError, match=r"\['amount'\]"):
        _run_tool(config)


# ---------------------------------------------------------------------------
# Config validation
# ---------------------------------------------------------------------------


def test_tool_config_error_missing_tool_type():
    with pytest.raises(ToolNodeConfigError, match="no usable 'tool_type'"):
        _run_tool({"url": "https://example.com"})


def test_tool_config_error_message_calls_out_tool_id_only_config():
    """
    The common authoring mistake deserves a message that names the cause.

    Since the tools module landed, a bare `tool_id` normally never reaches this
    handler — `graph_tasks._resolve_tool_configs` turns it into inline shape once
    per run, and an id that can't be resolved raises earlier with its own message.
    What lands here is a DB-less compile path (`compile_for_test_run`), so the
    message points at resolution rather than at a missing module.
    """
    with pytest.raises(ToolNodeConfigError, match="not resolved against the tools registry"):
        _run_tool({"tool_id": str(uuid.uuid4())})


def test_tool_config_error_unsupported_tool_type():
    with pytest.raises(ToolNodeConfigError, match="python_function"):
        _run_tool({"tool_type": "python_function"})


def test_tool_config_error_http_request_missing_url():
    with pytest.raises(ToolNodeConfigError, match="no usable 'url'"):
        _run_tool({"tool_type": "http_request", "method": "GET"})


def test_tool_config_error_http_request_bad_method():
    with pytest.raises(ToolNodeConfigError, match="unsupported 'method'"):
        _run_tool({**HTTP_CONFIG, "method": "TRACE"})


def test_tool_config_error_erp_unsupported_action():
    with pytest.raises(ToolNodeConfigError, match="unsupported 'action'"):
        _run_tool({**ERP_CONFIG, "action": "delete_everything"})


def test_tool_config_error_non_bool_is_mutating():
    """
    A string "true" would read as non-mutating to the publish-time approval
    guardrail and silently skip the gate, so it is rejected outright.
    """
    with pytest.raises(ToolNodeConfigError, match="malformed 'is_mutating'"):
        _run_tool({**ERP_CONFIG, "is_mutating": "true"})


def test_tool_config_error_malformed_body_fields():
    with pytest.raises(ToolNodeConfigError, match="malformed 'body_fields'"):
        _run_tool({**HTTP_CONFIG, "body_fields": ["node_outputs.extract.vendor_name"]})


# ---------------------------------------------------------------------------
# Compiler binding
# ---------------------------------------------------------------------------


def test_tool_node_compiles_and_runs_through_the_graph():
    """
    Proves the compiler's `_tool` closure now captures node.config — it did not
    before this phase, so a real handler would have seen an empty config.
    """
    version = _in_memory_version(
        nodes=[_node("start", "start"), _node("post_je", "tool", ERP_CONFIG), _node("end", "end")],
        edges=[_edge("start", "post_je"), _edge("post_je", "end")],
    )
    compiled = compile_for_test_run(version)
    state = initial_state_from_trigger(organization_id=uuid.uuid4())
    state["node_outputs"] = {"extract": EXTRACTION}

    result = run_graph_sync(compiled, state, thread_id="tool-compile")

    assert result["node_outputs"]["post_je"]["posted"] is True
    # Tool nodes contribute no LLM bookkeeping.
    assert result["node_usage"] == {}
    assert result["current_cost_usd"] == 0.0


# ---------------------------------------------------------------------------
# Full execution through the real engine — the headline test
# ---------------------------------------------------------------------------


async def _publish_erp_workflow(client: AsyncClient, tag: str) -> dict[str, Any]:
    """Publish the Vol. 5-shaped graph: start → extract → confidence_check → approval → post_journal_entry → end."""
    from test_workflow_versions import create_workflow, create_workspace, graph_payload, register_and_get_token

    from src.modules.workflows.schemas import EdgeInput, NodeInput, NodeType

    data = await register_and_get_token(client, f"toolnode-{tag}")
    token = data["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    ws = await create_workspace(client, token)
    wf = await create_workflow(client, token, ws["id"])

    nodes = [
        NodeInput(node_key="start", node_type=NodeType.start, config={}, position_x=0, position_y=0),
        NodeInput(node_key="extract", node_type=NodeType.agent, config=AGENT_CONFIG, position_x=100, position_y=0),
        NodeInput(node_key="confidence_check", node_type=NodeType.condition, config={}, position_x=200, position_y=0),
        NodeInput(node_key="human_approval", node_type=NodeType.human_approval, config={}, position_x=300, position_y=0),
        NodeInput(node_key="post_journal_entry", node_type=NodeType.tool, config=ERP_CONFIG, position_x=400, position_y=0),
        NodeInput(node_key="end", node_type=NodeType.end, config={}, position_x=500, position_y=0),
    ]
    edges = [
        EdgeInput(source_node_key="start", target_node_key="extract"),
        EdgeInput(source_node_key="extract", target_node_key="confidence_check"),
        EdgeInput(
            source_node_key="confidence_check",
            target_node_key="human_approval",
            condition={"field": "node_outputs.extract.confidence", "operator": "lt", "value": 0.8, "branch": "low"},
        ),
        EdgeInput(source_node_key="human_approval", target_node_key="post_journal_entry"),
        EdgeInput(source_node_key="post_journal_entry", target_node_key="end"),
    ]

    saved = await client.post(f"/api/v1/workflows/{wf['id']}/versions", json=graph_payload(nodes, edges), headers=headers)
    assert saved.status_code == 201, saved.text
    version_id = saved.json()["id"]

    published = await client.post(f"/api/v1/workflows/{wf['id']}/versions/{version_id}/publish", headers=headers)
    assert published.status_code == 200, published.text

    return {"headers": headers, "workflow_id": wf["id"], "version_id": version_id}


@pytest.mark.asyncio
async def test_erp_tool_workflow_runs_through_approval_and_persists_null_cost(client: AsyncClient, monkeypatch):
    """
    The headline test: a Volume-5-shaped graph with a mutating ERP tool downstream of
    a human_approval gate runs the full trigger → interrupt → resume → completed
    lifecycle, and the tool node's node_executions row carries the mock confirmation
    with NULL token/cost columns (tool nodes have no LLM cost).
    """
    from sqlalchemy import update as sa_update

    from src.db.database import async_session_maker
    from src.modules.executions.models import WorkflowRun

    monkeypatch.setattr(llm_client_module.settings, "OPENAI_API_KEY", "sk-test")

    ctx = await _publish_erp_workflow(client, "e2e")
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
    initial_state = initial_state_from_trigger(
        organization_id=uuid.UUID(run_data["organization_id"]),
        trigger_payload={"document": "invoice.pdf"},
        run_id=str(run_id),
    )

    # First stream — agent runs, low confidence routes to the approval gate.
    org_id = uuid.UUID(run_data["organization_id"])

    mock, _ = _patched_openai()
    try:
        await _stream_graph(run_id, version, initial_state, attempt=1, organization_id=org_id)
    finally:
        mock.stop()

    run = await _load_run_with_executions(run_id)
    assert run.status == "waiting_approval"

    async with async_session_maker() as session:
        await session.execute(sa_update(WorkflowRun).where(WorkflowRun.id == run_id).values(status="running", interrupt_payload=None))
        await session.commit()

    # Resume — approval returns, then the mutating tool node executes.
    from langgraph.types import Command

    await _stream_graph(run_id, version, Command(resume={"decision": "approved"}), attempt=1, organization_id=org_id)

    run = await _load_run_with_executions(run_id)
    assert run.status == "completed"

    executions = {ne.node_key: ne for ne in run.node_executions}
    assert "post_journal_entry" in executions

    tool_exec = executions["post_journal_entry"]
    assert tool_exec.status == "succeeded"

    posted = tool_exec.output["node_outputs"]["post_journal_entry"]
    assert posted["posted"] is True
    assert posted["confirmation_id"].startswith("MOCK-")
    assert posted["payload"] == {"account_code": "5000", "vendor": "Acme Corp", "amount": 1250.50}

    # Tool nodes have no LLM cost — the columns stay NULL rather than writing zeros.
    assert tool_exec.tokens_prompt is None
    assert tool_exec.tokens_completion is None
    assert tool_exec.cost_usd is None

    # ...while the agent node in the same run did populate them.
    assert executions["extract"].tokens_prompt == 1200
    assert float(executions["extract"].cost_usd) == pytest.approx(0.00096)

    # The run total reflects the agent only; the tool added nothing.
    assert float(run.total_cost_usd) == pytest.approx(0.00096)
