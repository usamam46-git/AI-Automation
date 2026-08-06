import { describe, expect, it } from "vitest";
import type { WorkflowVersion } from "@/lib/api";
import { flowToVersion, graphSignature, versionToFlow } from "@/lib/graph-mapping";

const version: WorkflowVersion = {
  id: "11111111-1111-1111-1111-111111111111",
  workflow_id: "22222222-2222-2222-2222-222222222222",
  version_number: 3,
  published_by: null,
  published_at: null,
  created_at: "2026-08-06T00:00:00Z",
  nodes: [
    // Node UUIDs are regenerated on every draft save, so they must never become
    // canvas identity — node_key is the only stable id.
    { id: "aaaaaaaa-0000-0000-0000-000000000001", node_key: "start_1", node_type: "start", config: {}, position_x: 10, position_y: 20 },
    {
      id: "aaaaaaaa-0000-0000-0000-000000000002",
      node_key: "agent_1",
      node_type: "agent",
      config: { system_prompt: "Extract", output_schema: { type: "object", properties: { vendor: { type: "string" } } } },
      position_x: 10,
      position_y: 140,
    },
    { id: "aaaaaaaa-0000-0000-0000-000000000003", node_key: "end_1", node_type: "end", config: null, position_x: 10, position_y: 260 },
  ],
  edges: [
    { id: "bbbbbbbb-0000-0000-0000-000000000001", source_node_key: "start_1", target_node_key: "agent_1", condition: null },
    {
      id: "bbbbbbbb-0000-0000-0000-000000000002",
      source_node_key: "agent_1",
      target_node_key: "end_1",
      condition: { field: "node_outputs.agent_1.confidence", operator: "gte", value: 0.8, branch: "high" },
    },
  ],
};

describe("versionToFlow", () => {
  it("uses node_key as the React Flow id, not the row UUID", () => {
    const graph = versionToFlow(version);
    expect(graph.nodes.map((node) => node.id)).toEqual(["start_1", "agent_1", "end_1"]);
    expect(graph.edges.map((edge) => edge.id)).toEqual(["start_1->agent_1", "agent_1->end_1"]);
  });

  it("carries the edge condition on edge.data", () => {
    const graph = versionToFlow(version);
    expect(graph.edges[1].data?.condition).toEqual(version.edges[1].condition);
    expect(graph.edges[0].data?.condition).toBeNull();
  });

  it("defaults a null position to the origin", () => {
    const graph = versionToFlow({
      ...version,
      nodes: [{ ...version.nodes[0], position_x: null, position_y: null }],
      edges: [],
    });
    expect(graph.nodes[0].position).toEqual({ x: 0, y: 0 });
  });

  it("returns an empty graph for a workflow with no version", () => {
    expect(versionToFlow(null)).toEqual({ nodes: [], edges: [] });
  });
});

describe("flowToVersion", () => {
  it("round-trips a version without losing config, condition or position", () => {
    const payload = flowToVersion(versionToFlow(version));

    expect(payload.nodes).toEqual([
      { node_key: "start_1", node_type: "start", config: {}, position_x: 10, position_y: 20 },
      { node_key: "agent_1", node_type: "agent", config: version.nodes[1].config, position_x: 10, position_y: 140 },
      { node_key: "end_1", node_type: "end", config: {}, position_x: 10, position_y: 260 },
    ]);
    expect(payload.edges).toEqual([
      { source_node_key: "start_1", target_node_key: "agent_1", condition: null },
      { source_node_key: "agent_1", target_node_key: "end_1", condition: version.edges[1].condition },
    ]);
  });

  it("rounds positions to whole pixels so a drag does not churn the payload", () => {
    const graph = versionToFlow(version);
    graph.nodes[0].position = { x: 10.4, y: 20.6 };
    const payload = flowToVersion(graph);
    expect(payload.nodes[0].position_x).toBe(10);
    expect(payload.nodes[0].position_y).toBe(21);
  });
});

describe("graphSignature", () => {
  it("ignores row order, so a freshly loaded graph does not read as dirty", () => {
    const payload = flowToVersion(versionToFlow(version));
    const reordered = { nodes: [...payload.nodes].reverse(), edges: [...payload.edges].reverse() };
    expect(graphSignature(reordered)).toBe(graphSignature(payload));
  });

  it("changes when a node's config changes", () => {
    const payload = flowToVersion(versionToFlow(version));
    const edited = {
      ...payload,
      nodes: payload.nodes.map((node) => (node.node_key === "agent_1" ? { ...node, config: { system_prompt: "Different" } } : node)),
    };
    expect(graphSignature(edited)).not.toBe(graphSignature(payload));
  });

  it("changes when a node moves", () => {
    const payload = flowToVersion(versionToFlow(version));
    const moved = { ...payload, nodes: payload.nodes.map((node, index) => (index === 0 ? { ...node, position_x: 99 } : node)) };
    expect(graphSignature(moved)).not.toBe(graphSignature(payload));
  });
});
