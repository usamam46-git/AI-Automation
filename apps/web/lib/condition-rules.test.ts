import { describe, expect, it } from "vitest";
import {
  branchLabel,
  describeRule,
  hasPredicate,
  orderConditionEdges,
  overlapRisk,
  type ConditionEdgeLike,
} from "@/lib/condition-rules";

function edge(id: string, condition: Record<string, unknown> | null): ConditionEdgeLike {
  return { id, source: "check", target: id, data: { condition } };
}

const rule = (field: string, operator = "gt", value: unknown = 100) => ({ field, operator, value });

describe("hasPredicate", () => {
  it("is true only when both field and operator are present", () => {
    expect(hasPredicate(rule("a.b"))).toBe(true);
  });

  it("treats null as a catch-all", () => {
    expect(hasPredicate(null)).toBe(false);
  });

  it("treats an empty condition as a catch-all", () => {
    expect(hasPredicate({})).toBe(false);
  });

  it("treats a branch-label-only condition as a catch-all", () => {
    // This is the shape the demo graphs use for the fallback arm.
    expect(hasPredicate({ branch: "auto_post" })).toBe(false);
  });

  it("treats a blank field as a catch-all, not a rule", () => {
    expect(hasPredicate({ field: "", operator: "eq" })).toBe(false);
  });

  it("needs the operator too", () => {
    expect(hasPredicate({ field: "a.b" })).toBe(false);
  });
});

describe("orderConditionEdges", () => {
  it("sorts the catch-all last", () => {
    // A fallback evaluated first would make every predicate behind it dead code
    // and silently route around a human-approval gate.
    const ordered = orderConditionEdges([edge("fallback", { branch: "auto" }), edge("gate", rule("total"))]);
    expect(ordered.map((item) => item.id)).toEqual(["gate", "fallback"]);
  });

  it("is stable among predicated branches", () => {
    const ordered = orderConditionEdges([edge("a", rule("x")), edge("b", rule("y")), edge("c", rule("z"))]);
    expect(ordered.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps several catch-alls after every predicate", () => {
    const ordered = orderConditionEdges([edge("f1", null), edge("p", rule("x")), edge("f2", null)]);
    expect(ordered.map((item) => item.id)).toEqual(["p", "f1", "f2"]);
  });

  it("handles an edge with no data at all", () => {
    const ordered = orderConditionEdges([{ id: "bare", source: "check", target: "x" }, edge("p", rule("x"))]);
    expect(ordered.map((item) => item.id)).toEqual(["p", "bare"]);
  });

  it("returns an empty list unchanged", () => {
    expect(orderConditionEdges([])).toEqual([]);
  });
});

describe("overlapRisk", () => {
  it("is false for one predicate and a fallback — the safe shape", () => {
    expect(overlapRisk([edge("gate", rule("total")), edge("auto", null)])).toBe(false);
  });

  it("is true for two predicated branches, whose relative order is not guaranteed", () => {
    // `save_draft` re-inserts every edge in one transaction, so created_at ties
    // and the backend's tiebreak falls through to a random UUID.
    expect(overlapRisk([edge("a", rule("total", "gt", 1000)), edge("b", rule("total", "gt", 100))])).toBe(true);
  });

  it("is false when nothing has a predicate", () => {
    expect(overlapRisk([edge("a", null), edge("b", null)])).toBe(false);
  });
});

describe("describeRule", () => {
  it("summarises a rule using the path's last segment", () => {
    expect(describeRule(rule("node_outputs.extract.total_amount", "gt", 1000))).toBe("total_amount gt 1000");
  });

  it("quotes a string value so it does not read as a path", () => {
    expect(describeRule(rule("a.status", "eq", "open"))).toBe('status eq "open"');
  });

  it("says a catch-all always runs", () => {
    expect(describeRule(null)).toBe("always runs");
    expect(describeRule({ branch: "auto" })).toBe("always runs");
  });
});

describe("branchLabel", () => {
  it("returns the label when set", () => {
    expect(branchLabel({ branch: "needs_approval" })).toBe("needs_approval");
  });

  it("returns null for a blank or missing label", () => {
    expect(branchLabel({ branch: "" })).toBeNull();
    expect(branchLabel(null)).toBeNull();
  });
});
