import { describe, expect, it } from "vitest";
import type { NodeType } from "@/lib/api";
import { inputSourcesFor, nodeOutputShape, SAMPLE_PAYLOAD_KEY } from "@/lib/node-output-shape";

function shape(nodeType: NodeType, config: Record<string, unknown> = {}, toolTypes?: Map<string, string>) {
  return nodeOutputShape({ nodeKey: "n1", nodeType, config, toolTypes });
}

function fieldPaths(result: ReturnType<typeof shape>): string[] {
  return result.fields.map((field) => field.path);
}

describe("nodeOutputShape — nodes that write nothing", () => {
  it("says an end node writes nothing", () => {
    const result = shape("end");
    expect(result.writesNothing).toBe(true);
    expect(result.fields).toEqual([]);
  });

  it("says a condition writes nothing, because it never executes", () => {
    expect(shape("condition").writesNothing).toBe(true);
  });

  it("says a subgraph writes nothing — the handler raises", () => {
    expect(shape("subgraph", { workflow_id: "abc" }).writesNothing).toBe(true);
  });

  it("distinguishes 'writes nothing' from 'not configured yet'", () => {
    // An unconfigured agent WILL write once its schema exists; an end node
    // never will. Conflating them would tell someone to fix an end node.
    expect(shape("agent").writesNothing).toBe(false);
    expect(shape("end").writesNothing).toBe(true);
  });
});

describe("nodeOutputShape — start", () => {
  it("describes the sample payload, rooted at trigger_payload", () => {
    const result = shape("start", { [SAMPLE_PAYLOAD_KEY]: { invoice: { total: 4200 } } });
    expect(fieldPaths(result)).toEqual(["trigger_payload.invoice"]);
    expect(result.fields[0].children[0].path).toBe("trigger_payload.invoice.total");
  });

  it("is NOT rooted at node_outputs — a start node writes no node_outputs entry", () => {
    const result = shape("start", { [SAMPLE_PAYLOAD_KEY]: { a: 1 } });
    expect(fieldPaths(result).every((path) => !path.startsWith("node_outputs"))).toBe(true);
  });

  it("asks for a sample when there is none, rather than claiming nothing exists", () => {
    const result = shape("start");
    expect(result.writesNothing).toBe(false);
    expect(result.note).toMatch(/sample/i);
  });

  it("ignores a non-object sample", () => {
    expect(shape("start", { [SAMPLE_PAYLOAD_KEY]: "not an object" }).fields).toEqual([]);
  });
});

describe("nodeOutputShape — agent", () => {
  it("derives its fields from output_schema.properties", () => {
    const result = shape("agent", {
      output_schema: {
        type: "object",
        properties: { vendor_name: { type: "string" }, total_amount: { type: "number" } },
      },
    });
    expect(fieldPaths(result)).toEqual(["node_outputs.n1.vendor_name", "node_outputs.n1.total_amount"]);
  });

  it("reads the non-null member of a nullable type", () => {
    // Optionality is a nullable type — strict mode makes every property
    // required, which is why no `required` array is ever emitted.
    const result = shape("agent", {
      output_schema: { type: "object", properties: { po: { type: ["string", "null"] } } },
    });
    expect(result.fields[0].kind).toBe("string");
  });

  it("maps integer to number", () => {
    const result = shape("agent", {
      output_schema: { type: "object", properties: { count: { type: "integer" } } },
    });
    expect(result.fields[0].kind).toBe("number");
  });

  it("prompts for a schema when there is none", () => {
    expect(shape("agent").note).toMatch(/output schema/i);
  });

  it("reports an empty properties object distinctly", () => {
    const result = shape("agent", { output_schema: { type: "object", properties: {} } });
    expect(result.fields).toEqual([]);
    expect(result.note).toMatch(/no properties/i);
  });
});

describe("nodeOutputShape — human_approval", () => {
  it("produces the resume payload's own shape", () => {
    expect(fieldPaths(shape("human_approval"))).toEqual(["node_outputs.n1.decision", "node_outputs.n1.comment"]);
  });
});

describe("nodeOutputShape — tool", () => {
  it("shapes an http_request as status_code + body", () => {
    // Headers are deliberately never echoed into state.
    expect(fieldPaths(shape("tool", { tool_type: "http_request" }))).toEqual([
      "node_outputs.n1.status_code",
      "node_outputs.n1.body",
    ]);
  });

  it("shapes an erp_connector", () => {
    const result = shape("tool", { tool_type: "erp_connector", action: "create_journal_entry" });
    expect(fieldPaths(result)).toContain("node_outputs.n1.confirmation_id");
    expect(result.fields.find((field) => field.key === "action")?.value).toBe("create_journal_entry");
  });

  it("shapes knowledge_search down into a hit", () => {
    const result = shape("tool", { tool_type: "knowledge_search" });
    const hits = result.fields.find((field) => field.key === "hits");
    expect(hits?.children[0].children.map((child) => child.path)).toContain("node_outputs.n1.hits.0.score");
  });

  it("shapes notify as queued, never delivered", () => {
    const keys = shape("tool", { tool_type: "notify" }).fields.map((field) => field.key);
    expect(keys).toContain("queued");
    expect(keys).not.toContain("delivered");
  });

  it("resolves a registry tool_id through the type map", () => {
    const toolTypes = new Map([["tool-uuid", "knowledge_search"]]);
    expect(fieldPaths(shape("tool", { tool_id: "tool-uuid" }, toolTypes))).toContain("node_outputs.n1.hit_count");
  });

  it("lets inline tool_type WIN over tool_id, exactly as the backend does", () => {
    // `_tool_config` reads tool_type first, so a node carrying both is an inline
    // node with a dead tool_id. Reading them the other way round would describe
    // a call that never happens.
    const toolTypes = new Map([["tool-uuid", "knowledge_search"]]);
    expect(fieldPaths(shape("tool", { tool_type: "http_request", tool_id: "tool-uuid" }, toolTypes))).toEqual([
      "node_outputs.n1.status_code",
      "node_outputs.n1.body",
    ]);
  });

  it("asks for a tool type when the node has neither", () => {
    expect(shape("tool", {}).note).toMatch(/tool type/i);
  });

  it("says the registry row is missing when a tool_id resolves to nothing", () => {
    expect(shape("tool", { tool_id: "gone" }, new Map()).note).toMatch(/still exists/i);
  });
});

describe("inputSourcesFor", () => {
  const node = (id: string, nodeType: NodeType) => ({ id, nodeType });
  const edge = (source: string, target: string) => ({ source, target });

  it("returns the direct predecessor", () => {
    const graph = { nodes: [node("a", "agent"), node("b", "tool")], edges: [edge("a", "b")] };
    expect(inputSourcesFor("b", graph)).toEqual(["a"]);
  });

  it("returns nothing for a node with no incoming edge", () => {
    const graph = { nodes: [node("a", "start")], edges: [] };
    expect(inputSourcesFor("a", graph)).toEqual([]);
  });

  it("returns every predecessor when branches converge", () => {
    const graph = {
      nodes: [node("a", "agent"), node("b", "agent"), node("c", "tool")],
      edges: [edge("a", "c"), edge("b", "c")],
    };
    expect(inputSourcesFor("c", graph).sort()).toEqual(["a", "b"]);
  });

  it("walks THROUGH a condition node, which writes nothing", () => {
    // Otherwise a node behind a condition gets a permanently empty input panel
    // while the data it reads sits one step further back.
    const graph = {
      nodes: [node("extract", "agent"), node("check", "condition"), node("post", "tool")],
      edges: [edge("extract", "check"), edge("check", "post")],
    };
    expect(inputSourcesFor("post", graph)).toEqual(["extract"]);
  });

  it("walks through a chain of conditions", () => {
    const graph = {
      nodes: [node("a", "agent"), node("c1", "condition"), node("c2", "condition"), node("z", "tool")],
      edges: [edge("a", "c1"), edge("c1", "c2"), edge("c2", "z")],
    };
    expect(inputSourcesFor("z", graph)).toEqual(["a"]);
  });

  it("excludes forward references — a downstream node has not run yet", () => {
    const graph = { nodes: [node("a", "agent"), node("b", "tool")], edges: [edge("a", "b")] };
    expect(inputSourcesFor("a", graph)).toEqual([]);
  });

  it("terminates on a cyclic draft", () => {
    const graph = {
      nodes: [node("a", "agent"), node("b", "agent")],
      edges: [edge("a", "b"), edge("b", "a")],
    };
    expect(inputSourcesFor("a", graph)).toEqual(["b"]);
  });

  it("ignores an edge pointing at a node that is not on the canvas", () => {
    const graph = { nodes: [node("b", "tool")], edges: [edge("ghost", "b")] };
    expect(inputSourcesFor("b", graph)).toEqual([]);
  });
});
