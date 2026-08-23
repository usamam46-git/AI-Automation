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


def _as_index(part: str) -> int | None:
    """`"0"` / `"-1"` -> int; anything else -> None. No exceptions on the hot path."""
    candidate = part[1:] if part.startswith("-") else part
    return int(part) if candidate.isdigit() else None


def resolve_field_path(state: dict[str, Any], field_path: str) -> Any:
    """
    Traverse a dotted path against nested state (no code execution).

    Dicts are traversed by key and **sequences by integer index**, so
    `node_outputs.get_vendor.body.data.0.id` reaches into a list-shaped response.
    Negative indices count from the end (`...results.-1`), which is the idiomatic
    way to ask for "the latest" record.

    List indexing was added 2026-08-23. Before it, hitting a list returned None
    and stopped: `{"data": [{...}]}` is the single most common shape a real REST
    API returns, so every `http_request` tool node pointed at one had an
    unreachable payload — the condition DSL, agent `input_fields` and a tool's
    `body_fields` all route through here, so all three were affected at once.

    A dict is always traversed as a dict, even when the key looks numeric, so a
    JSON object keyed by id (`{"1042": {...}}`) still resolves by key. Strings are
    NOT indexable: `resolve_field_path` addresses structure, and slicing a string
    by position is a text operation that belongs nowhere near routing.

    Any miss — absent key, out-of-range index, or a scalar with path left to walk
    — returns None rather than raising. Callers distinguish "resolved to nothing"
    themselves; `evaluate_condition` treats None as a failed comparison, and
    `_resolve_url_fields` in node_handlers raises on it because a URL with a None
    in the path is a request to the wrong resource.
    """
    current: Any = state
    for part in field_path.split("."):
        if isinstance(current, dict):
            current = current.get(part)
            continue
        if isinstance(current, list | tuple):
            index = _as_index(part)
            if index is None or not -len(current) <= index < len(current):
                return None
            current = current[index]
            continue
        return None
    return current


def has_predicate(condition: dict[str, Any] | None) -> bool:
    """
    Whether `condition` actually compares anything.

    False for a null condition and for branch-only metadata (a dict carrying a
    `branch` label but no `field`/`operator`). `evaluate_condition` returns True
    for both of those, i.e. they match every state — so an edge carrying one is a
    catch-all fallback, not a test.

    This lives next to `evaluate_condition` and is used *by* it so the two
    definitions of "matches everything" cannot drift. The compiler's condition
    router depends on the answer: it sorts catch-all edges last, and a fallback
    that sorted first would make every predicate behind it dead code. See
    `_ordered_condition_edges` in src/graphs/compiler.py.
    """
    if condition is None:
        return False
    return condition.get("field") is not None and condition.get("operator") is not None


def evaluate_condition(condition: dict[str, Any] | None, state: dict[str, Any]) -> bool:
    """
    Evaluate a structured condition dict against workflow state.

    Returns True when the condition is absent, lacks predicate fields (branch-only metadata),
    or the comparison succeeds.
    """
    if not has_predicate(condition):
        return True
    assert condition is not None  # narrowed by has_predicate

    field = condition["field"]
    operator = condition["operator"]

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
