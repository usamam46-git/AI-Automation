"""
Safe conditional-edge evaluation using a structured comparison DSL.

Edge `condition` jsonb shape:
  {"field": "node_outputs.extract.confidence", "operator": "gte", "value": 0.8, "branch": "high"}

Optional `branch` is a routing label for LangGraph path maps; it is not evaluated here.
Never uses eval() or arbitrary code execution.
"""

from __future__ import annotations

from typing import Any

SUPPORTED_OPERATORS = frozenset({"eq", "neq", "gt", "gte", "lt", "lte", "in", "contains"})


def resolve_field_path(state: dict[str, Any], field_path: str) -> Any:
    """Traverse a dotted path against nested dict state (no code execution)."""
    current: Any = state
    for part in field_path.split("."):
        if not isinstance(current, dict):
            return None
        current = current.get(part)
    return current


def evaluate_condition(condition: dict[str, Any] | None, state: dict[str, Any]) -> bool:
    """
    Evaluate a structured condition dict against workflow state.

    Returns True when the condition is absent, lacks predicate fields (branch-only metadata),
    or the comparison succeeds.
    """
    if condition is None:
        return True

    field = condition.get("field")
    operator = condition.get("operator")
    if field is None or operator is None:
        return True

    if operator not in SUPPORTED_OPERATORS:
        raise ValueError(f"Unsupported condition operator: {operator}")

    actual = resolve_field_path(state, str(field))
    expected = condition.get("value")

    if operator == "eq":
        return actual == expected
    if operator == "neq":
        return actual != expected
    if operator == "gt":
        return actual is not None and expected is not None and actual > expected
    if operator == "gte":
        return actual is not None and expected is not None and actual >= expected
    if operator == "lt":
        return actual is not None and expected is not None and actual < expected
    if operator == "lte":
        return actual is not None and expected is not None and actual <= expected
    if operator == "in":
        if not isinstance(expected, list | tuple | set):
            return False
        return actual in expected
    if operator == "contains":
        if actual is None:
            return False
        if isinstance(actual, str):
            return str(expected) in actual
        if isinstance(actual, list | tuple | set | dict):
            return expected in actual
        return False

    return False
