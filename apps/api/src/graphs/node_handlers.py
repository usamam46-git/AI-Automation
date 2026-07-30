"""
Per-node-type callables bound into LangGraph StateGraph nodes.

`condition`-type rows are NOT handled here — they compile into routing functions
on conditional edges, not executable graph nodes.
"""

from __future__ import annotations

from typing import Any

from langgraph.types import interrupt


class NodeNotImplementedError(Exception):
    """Raised when a stub node handler is invoked before its module exists."""


def start_handler(_state: dict[str, Any]) -> dict[str, Any]:
    return {}


def end_handler(_state: dict[str, Any]) -> dict[str, Any]:
    return {}


def human_approval_handler(state: dict[str, Any]) -> dict[str, Any]:
    """
    Calls LangGraph interrupt() to pause execution.

    Resume via Command(resume=...) is wired in the execution engine (next phase).
    This handler is compile-time correct for in-process test runs only.
    """
    payload = {
        "type": "approval_request",
        "node_outputs": state.get("node_outputs", {}),
    }
    decision = interrupt(payload)
    node_outputs = dict(state.get("node_outputs", {}))
    node_outputs["human_approval"] = decision
    return {"node_outputs": node_outputs}


def agent_handler(_state: dict[str, Any], *, node_key: str, node_type: str = "agent") -> dict[str, Any]:
    raise NodeNotImplementedError(f"Node type '{node_type}' requires the Agent module, not yet implemented (node_key={node_key})")


def tool_handler(_state: dict[str, Any], *, node_key: str, node_type: str = "tool") -> dict[str, Any]:
    raise NodeNotImplementedError(f"Node type '{node_type}' requires the Tool module, not yet implemented (node_key={node_key})")


def subgraph_handler(_state: dict[str, Any], *, node_key: str, node_type: str = "subgraph") -> dict[str, Any]:
    raise NodeNotImplementedError(f"Node type '{node_type}' requires the Subgraph module, not yet implemented (node_key={node_key})")
