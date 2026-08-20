import { describe, expect, it } from "vitest";
import type { BuilderGraph } from "@/lib/graph-mapping";
import { renameNodeKey, retargetStatePath, rewriteStatePaths, validateNodeKey } from "@/lib/node-rename";

function graph(): BuilderGraph {
  return {
    nodes: [
      { id: "start_1", type: "start", position: { x: 0, y: 0 }, data: { nodeKey: "start_1", nodeType: "start", config: {} } },
      {
        id: "agent_1",
        type: "agent",
        position: { x: 0, y: 120 },
        data: { nodeKey: "agent_1", nodeType: "agent", config: { input_fields: ["trigger_payload"] } },
      },
      {
        id: "agent_10",
        type: "agent",
        position: { x: 0, y: 240 },
        data: {
          nodeKey: "agent_10",
          nodeType: "agent",
          config: { input_fields: ["node_outputs.agent_1", "node_outputs.agent_10.note"] },
        },
      },
      {
        id: "tool_1",
        type: "tool",
        position: { x: 0, y: 360 },
        data: {
          nodeKey: "tool_1",
          nodeType: "tool",
          config: { payload_fields: { vendor: "node_outputs.agent_1.vendor", note: "node_outputs.other.agent_1" } },
        },
      },
    ],
    edges: [
      { id: "start_1->agent_1", source: "start_1", target: "agent_1", data: { condition: null } },
      {
        id: "agent_1->tool_1",
        source: "agent_1",
        target: "tool_1",
        data: { condition: { field: "node_outputs.agent_1.approved", operator: "eq", value: true } },
      },
    ],
  };
}

describe("validateNodeKey", () => {
  it("accepts the auto-generated shape and readable names", () => {
    expect(validateNodeKey("extract_invoice", "agent_1", ["agent_1", "tool_1"])).toBeNull();
    expect(validateNodeKey("agent_2", "agent_1", ["agent_1"])).toBeNull();
  });

  it("allows re-committing the node's own current key", () => {
    expect(validateNodeKey("agent_1", "agent_1", ["agent_1", "tool_1"])).toBeNull();
  });

  it("rejects a collision with another node", () => {
    expect(validateNodeKey("tool_1", "agent_1", ["agent_1", "tool_1"])).toBe("Another node already uses tool_1.");
  });

  it("rejects empty, over-long and malformed keys", () => {
    expect(validateNodeKey("   ", "agent_1", [])).toBe("A node key is required.");
    expect(validateNodeKey("a".repeat(65), "agent_1", [])).toBe("A node key is at most 64 characters.");
    for (const bad of ["Extract", "1st_node", "with space", "dotted.key", "_leading"]) {
      expect(validateNodeKey(bad, "agent_1", [])).toMatch(/lowercase/);
    }
  });
});

describe("retargetStatePath", () => {
  it("rewrites only a node_outputs reference to the renamed node", () => {
    expect(retargetStatePath("node_outputs.agent_1.vendor", "agent_1", "extract")).toBe("node_outputs.extract.vendor");
    expect(retargetStatePath("node_outputs.agent_1", "agent_1", "extract")).toBe("node_outputs.extract");
  });

  it("does not match on a segment prefix", () => {
    expect(retargetStatePath("node_outputs.agent_10.note", "agent_1", "extract")).toBe("node_outputs.agent_10.note");
  });

  it("leaves other roots and same-named fields alone", () => {
    expect(retargetStatePath("trigger_payload.agent_1", "agent_1", "extract")).toBe("trigger_payload.agent_1");
    expect(retargetStatePath("node_outputs.other.agent_1", "agent_1", "extract")).toBe("node_outputs.other.agent_1");
    expect(retargetStatePath("agent_1", "agent_1", "extract")).toBe("agent_1");
  });
});

describe("rewriteStatePaths", () => {
  it("walks arrays, nested objects and leaves non-strings untouched", () => {
    const config = {
      input_fields: ["node_outputs.agent_1.vendor", "trigger_payload"],
      nested: { deep: { field: "node_outputs.agent_1.amount" }, top_k: 5, on: true, missing: null },
    };
    expect(rewriteStatePaths(config, "agent_1", "extract")).toEqual({
      input_fields: ["node_outputs.extract.vendor", "trigger_payload"],
      nested: { deep: { field: "node_outputs.extract.amount" }, top_k: 5, on: true, missing: null },
    });
  });
});

describe("renameNodeKey", () => {
  it("moves the node's own identity", () => {
    const next = renameNodeKey(graph(), "agent_1", "extract");
    const node = next.nodes.find((item) => item.id === "extract");
    expect(node?.data.nodeKey).toBe("extract");
    expect(next.nodes.some((item) => item.id === "agent_1")).toBe(false);
  });

  it("rewires both ends of every touching edge and rebuilds the derived id", () => {
    const next = renameNodeKey(graph(), "agent_1", "extract");
    expect(next.edges.map((edge) => edge.id)).toEqual(["start_1->extract", "extract->tool_1"]);
    expect(next.edges[0].target).toBe("extract");
    expect(next.edges[1].source).toBe("extract");
  });

  it("retargets state paths in downstream configs and in edge conditions", () => {
    const next = renameNodeKey(graph(), "agent_1", "extract");
    const tool = next.nodes.find((item) => item.id === "tool_1");
    expect(tool?.data.config.payload_fields).toEqual({
      vendor: "node_outputs.extract.vendor",
      // A field that merely shares the node's name is not a reference to it.
      note: "node_outputs.other.agent_1",
    });
    expect(next.edges[1].data?.condition).toEqual({ field: "node_outputs.extract.approved", operator: "eq", value: true });
  });

  it("does not disturb a node whose key only shares a prefix", () => {
    const next = renameNodeKey(graph(), "agent_1", "extract");
    const sibling = next.nodes.find((item) => item.id === "agent_10");
    expect(sibling?.data.config.input_fields).toEqual(["node_outputs.extract", "node_outputs.agent_10.note"]);
  });

  it("is a no-op for an unchanged key or an unknown node", () => {
    const before = graph();
    expect(renameNodeKey(before, "agent_1", "agent_1")).toBe(before);
    expect(renameNodeKey(before, "ghost_1", "extract")).toBe(before);
  });
});
