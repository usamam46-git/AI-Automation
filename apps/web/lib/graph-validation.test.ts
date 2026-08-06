import { describe, expect, it } from "vitest";
import type { BuilderGraph, BuilderNode } from "@/lib/graph-mapping";
import { edgeId } from "@/lib/graph-mapping";
import { parseValidationDetail, validateDraft, validateGraph, type ValidationRule } from "@/lib/graph-validation";
import type { NodeType } from "@/lib/api";

function node(key: string, nodeType: NodeType, config: Record<string, unknown> = {}): BuilderNode {
  return { id: key, type: nodeType, position: { x: 0, y: 0 }, data: { nodeKey: key, nodeType, config } };
}

function graph(nodes: BuilderNode[], edges: Array<[string, string]>): BuilderGraph {
  return {
    nodes,
    edges: edges.map(([source, target]) => ({ id: edgeId(source, target), source, target, data: { condition: null } })),
  };
}

function rules(issues: Array<{ rule: ValidationRule }>): ValidationRule[] {
  return issues.map((issue) => issue.rule).sort();
}

describe("validateDraft", () => {
  it("accepts partial graphs the canvas produces mid-construction", () => {
    // Each of these is rejected by the full rules but must save as a draft —
    // this is the frontend half of the backend's draft/publish validation split.
    const partials: BuilderGraph[] = [
      graph([], []),
      graph([node("agent_1", "agent")], []),
      graph([node("start_1", "start"), node("end_1", "end")], []),
      graph([node("start_1", "start"), node("agent_1", "agent")], [["start_1", "agent_1"]]),
    ];

    for (const partial of partials) {
      expect(validateDraft(partial)).toEqual([]);
      // Guard against this list rotting into graphs that are already valid.
      if (partial.nodes.length > 0) expect(validateGraph(partial).length).toBeGreaterThan(0);
    }
  });

  it("flags an edge pointing at a node that no longer exists", () => {
    const broken: BuilderGraph = {
      nodes: [node("start_1", "start")],
      edges: [{ id: "start_1->gone", source: "start_1", target: "gone", data: { condition: null } }],
    };
    expect(rules(validateDraft(broken))).toEqual(["dangling_edge"]);
    expect(validateDraft(broken)[0].nodeKeys).toEqual(["start_1"]);
  });
});

describe("validateGraph", () => {
  const complete = graph(
    [node("start_1", "start"), node("agent_1", "agent"), node("end_1", "end")],
    [
      ["start_1", "agent_1"],
      ["agent_1", "end_1"],
    ],
  );

  it("accepts a complete graph", () => {
    expect(validateGraph(complete)).toEqual([]);
  });

  it("requires a start and an end", () => {
    expect(rules(validateGraph(graph([node("agent_1", "agent")], [])))).toContain("missing_start");
    expect(rules(validateGraph(graph([node("agent_1", "agent")], [])))).toContain("missing_end");
  });

  it("flags unconnected nodes", () => {
    const withOrphan: BuilderGraph = {
      nodes: [...complete.nodes, node("tool_1", "tool")],
      edges: complete.edges,
    };
    const orphan = validateGraph(withOrphan).find((issue) => issue.rule === "orphan");
    expect(orphan?.nodeKeys).toEqual(["tool_1"]);
  });

  it("flags a cycle", () => {
    const cyclic = graph(
      [node("start_1", "start"), node("a", "agent"), node("b", "agent"), node("end_1", "end")],
      [
        ["start_1", "a"],
        ["a", "b"],
        ["b", "a"],
        ["b", "end_1"],
      ],
    );
    const cycle = validateGraph(cyclic).find((issue) => issue.rule === "cycle");
    expect(cycle).toBeDefined();
    expect(cycle?.nodeKeys.sort()).toEqual(["a", "b"]);
  });

  it("flags a mutating node with no approval anywhere upstream", () => {
    const unguarded = graph(
      [node("start_1", "start"), node("post_je", "tool", { is_mutating: true }), node("end_1", "end")],
      [
        ["start_1", "post_je"],
        ["post_je", "end_1"],
      ],
    );
    const issue = validateGraph(unguarded).find((item) => item.rule === "unguarded_mutating");
    expect(issue?.nodeKeys).toEqual(["post_je"]);
  });

  it("passes a mutating node whose ancestors include an approval", () => {
    const guarded = graph(
      [node("start_1", "start"), node("approval_1", "human_approval"), node("post_je", "tool", { is_mutating: true }), node("end_1", "end")],
      [
        ["start_1", "approval_1"],
        ["approval_1", "post_je"],
        ["post_je", "end_1"],
      ],
    );
    expect(rules(validateGraph(guarded))).toEqual([]);
  });

  it("uses ∃-semantics: one approved branch is enough", () => {
    // Mirrors validate_mutating_approval exactly. Vol. 5 §1 and §5 both route
    // straight to the journal-entry write on their clean branch, so ∀ would
    // reject the blueprint's own reference workflows. Do not tighten this
    // without changing the backend first.
    const oneApprovedBranch = graph(
      [
        node("start_1", "start"),
        node("condition_1", "condition"),
        node("approval_1", "human_approval"),
        node("post_je", "tool", { is_mutating: true }),
        node("end_1", "end"),
      ],
      [
        ["start_1", "condition_1"],
        ["condition_1", "approval_1"],
        ["approval_1", "post_je"],
        // Second branch reaches the write with no approval on its path.
        ["condition_1", "post_je"],
        ["post_je", "end_1"],
      ],
    );
    expect(rules(validateGraph(oneApprovedBranch))).toEqual([]);
  });

  it("does not report phantom orphans caused by a dangling edge", () => {
    const broken: BuilderGraph = {
      nodes: complete.nodes,
      edges: [...complete.edges, { id: "agent_1->gone", source: "agent_1", target: "gone", data: { condition: null } }],
    };
    expect(rules(validateGraph(broken))).toEqual(["dangling_edge"]);
  });

  it("treats a mutating node marked with the string \"true\" as non-mutating", () => {
    // Matches the backend: only a literal boolean true counts. `_tool_config`
    // rejects the string at invoke time, so this must not be quietly accepted.
    const stringFlag = graph(
      [node("start_1", "start"), node("post_je", "tool", { is_mutating: "true" }), node("end_1", "end")],
      [
        ["start_1", "post_je"],
        ["post_je", "end_1"],
      ],
    );
    expect(rules(validateGraph(stringFlag))).toEqual([]);
  });
});

describe("parseValidationDetail", () => {
  const known = new Set(["agent_1", "post_je", "a", "b"]);

  it("reads the structured dangling-edge detail", () => {
    const issue = parseValidationDetail(
      { message: "Edges reference nonexistent node_key values", invalid_edges: [{ source_node_key: "agent_1", target_node_key: "gone", missing: "target 'gone'" }] },
      known,
    );
    expect(issue.rule).toBe("dangling_edge");
    expect(issue.nodeKeys).toEqual(["agent_1"]);
  });

  it("extracts keys from a Python-repr list", () => {
    const issue = parseValidationDetail("Duplicate node_key values: ['agent_1']", known);
    expect(issue.rule).toBe("duplicate_key");
    expect(issue.nodeKeys).toEqual(["agent_1"]);
  });

  it("extracts keys from a cycle path", () => {
    const issue = parseValidationDetail("Cycle detected in graph: a -> b -> a", known);
    expect(issue.rule).toBe("cycle");
    expect(issue.nodeKeys.sort()).toEqual(["a", "b"]);
  });

  it("attributes the mutating-approval rejection to its node", () => {
    const issue = parseValidationDetail(
      "Mutating nodes have no human_approval node in their upstream dependency path: ['post_je']. A node marked 'is_mutating: true' writes to an external system.",
      known,
    );
    expect(issue.rule).toBe("unguarded_mutating");
    expect(issue.nodeKeys).toEqual(["post_je"]);
  });

  it("keeps an unattributable message rather than dropping it", () => {
    const issue = parseValidationDetail("Graph must contain at least one start node.", known);
    expect(issue.nodeKeys).toEqual([]);
    expect(issue.message).toContain("start node");
  });
});
