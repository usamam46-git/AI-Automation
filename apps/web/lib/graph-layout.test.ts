import { describe, expect, it } from "vitest";
import { layoutGraph, looksVertical, type LayoutEdge, type LayoutNode } from "@/lib/graph-layout";

function nodes(...ids: string[]): LayoutNode[] {
  return ids.map((id) => ({ id }));
}

function edges(...pairs: [string, string][]): LayoutEdge[] {
  return pairs.map(([source, target]) => ({ source, target }));
}

/** Layer index recovered from an x coordinate, given the default rank spacing. */
function layerOf(positions: Record<string, { x: number; y: number }>, id: string, rankSpacing = 300): number {
  return positions[id].x / rankSpacing;
}

describe("layoutGraph", () => {
  it("returns nothing for an empty graph", () => {
    expect(layoutGraph({ nodes: [], edges: [] })).toEqual({});
  });

  it("places a lone node at the origin", () => {
    expect(layoutGraph({ nodes: nodes("start_1"), edges: [] })).toEqual({ start_1: { x: 0, y: 0 } });
  });

  it("lays a spine out left to right, one layer per step", () => {
    const positions = layoutGraph({
      nodes: nodes("start_1", "agent_1", "end_1"),
      edges: edges(["start_1", "agent_1"], ["agent_1", "end_1"]),
    });

    expect(layerOf(positions, "start_1")).toBe(0);
    expect(layerOf(positions, "agent_1")).toBe(1);
    expect(layerOf(positions, "end_1")).toBe(2);
  });

  it("keeps a single chain on one horizontal line", () => {
    const positions = layoutGraph({
      nodes: nodes("a", "b", "c"),
      edges: edges(["a", "b"], ["b", "c"]),
    });

    expect(positions.a.y).toBe(positions.b.y);
    expect(positions.b.y).toBe(positions.c.y);
  });

  it("uses the LONGEST path, so a node sits right of every predecessor", () => {
    // b -> d is a short hop, but d also sits behind the a->b->c->d chain.
    const positions = layoutGraph({
      nodes: nodes("a", "b", "c", "d"),
      edges: edges(["a", "b"], ["b", "c"], ["c", "d"], ["b", "d"]),
    });

    expect(layerOf(positions, "d")).toBe(3);
    expect(positions.d.x).toBeGreaterThan(positions.c.x);
    expect(positions.d.x).toBeGreaterThan(positions.b.x);
  });

  it("separates two branches of a condition onto different rows", () => {
    const positions = layoutGraph({
      nodes: nodes("check", "approve", "auto"),
      edges: edges(["check", "approve"], ["check", "auto"]),
    });

    expect(layerOf(positions, "approve")).toBe(1);
    expect(layerOf(positions, "auto")).toBe(1);
    expect(positions.approve.y).not.toBe(positions.auto.y);
  });

  it("centres a short layer against the tallest one", () => {
    // Layer 1 holds two nodes, layer 0 and 2 hold one each — the singles should
    // sit level with the midpoint of the pair, not at its top.
    const positions = layoutGraph({
      nodes: nodes("start", "up", "down", "join"),
      edges: edges(["start", "up"], ["start", "down"], ["up", "join"], ["down", "join"]),
    });

    const midpoint = (positions.up.y + positions.down.y) / 2;
    expect(positions.start.y).toBe(midpoint);
    expect(positions.join.y).toBe(midpoint);
  });

  it("respects custom spacing and origin", () => {
    const positions = layoutGraph(
      { nodes: nodes("a", "b"), edges: edges(["a", "b"]) },
      { rankSpacing: 100, nodeSpacing: 50, originX: 30, originY: 7 },
    );

    expect(positions.a).toEqual({ x: 30, y: 7 });
    expect(positions.b).toEqual({ x: 130, y: 7 });
  });

  it("terminates on a cyclic graph — the canvas holds invalid drafts", () => {
    const positions = layoutGraph({
      nodes: nodes("a", "b", "c"),
      edges: edges(["a", "b"], ["b", "c"], ["c", "a"]),
    });

    expect(Object.keys(positions).sort()).toEqual(["a", "b", "c"]);
  });

  it("terminates when every node is inside the cycle", () => {
    const positions = layoutGraph({ nodes: nodes("a", "b"), edges: edges(["a", "b"], ["b", "a"]) });
    expect(Object.keys(positions).sort()).toEqual(["a", "b"]);
  });

  it("ignores self-loops and edges to nodes that are not on the canvas", () => {
    // `dangling_edge` reports these; layout must not let them strand the graph.
    const positions = layoutGraph({
      nodes: nodes("a", "b"),
      edges: edges(["a", "a"], ["a", "b"], ["b", "ghost"], ["ghost", "a"]),
    });

    expect(layerOf(positions, "a")).toBe(0);
    expect(layerOf(positions, "b")).toBe(1);
  });

  it("places a disconnected node in the first layer", () => {
    const positions = layoutGraph({
      nodes: nodes("a", "b", "lonely"),
      edges: edges(["a", "b"]),
    });

    expect(layerOf(positions, "lonely")).toBe(0);
  });

  it("routes a skip edge around the card it passes, not through it", () => {
    // `a -> c` spans two layers, so a dummy joins `b` in layer 1 and pushes the
    // two apart. Without that the bypass is drawn straight through b's card.
    const positions = layoutGraph({
      nodes: nodes("a", "b", "c"),
      edges: edges(["a", "b"], ["b", "c"], ["a", "c"]),
    });

    expect(layerOf(positions, "b")).toBe(1);
    expect(layerOf(positions, "c")).toBe(2);
    expect(positions.b.y).not.toBe(positions.a.y);
  });

  it("never leaks a routing dummy into the result", () => {
    const positions = layoutGraph({
      nodes: nodes("a", "b", "c", "d"),
      edges: edges(["a", "b"], ["b", "c"], ["c", "d"], ["a", "d"]),
    });

    expect(Object.keys(positions).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps the visible graph on the requested origin despite dummy routing", () => {
    const positions = layoutGraph({
      nodes: nodes("a", "b", "c"),
      edges: edges(["a", "b"], ["b", "c"], ["a", "c"]),
    });

    expect(Math.min(...Object.values(positions).map((point) => point.y))).toBe(0);
  });

  it("is deterministic — the same graph lays out identically twice", () => {
    const graph = {
      nodes: nodes("start", "one", "two", "three", "join", "end"),
      edges: edges(
        ["start", "one"],
        ["start", "two"],
        ["start", "three"],
        ["one", "join"],
        ["two", "join"],
        ["three", "join"],
        ["join", "end"],
      ),
    };

    expect(layoutGraph(graph)).toEqual(layoutGraph(graph));
  });

  it("pulls a connected node level with its predecessor rather than leaving it stranded", () => {
    // `tail` hangs off `mid`, so the barycentre pass should line the two up
    // instead of leaving `tail` at the top of its layer beside `other`.
    const positions = layoutGraph({
      nodes: nodes("start", "other", "mid", "tail"),
      edges: edges(["start", "other"], ["start", "mid"], ["mid", "tail"]),
    });

    expect(positions.tail.y).toBe(positions.mid.y);
  });

  it("lays the seeded invoice-approval graph out without collisions", () => {
    const positions = layoutGraph({
      nodes: nodes(
        "start_1",
        "extract_invoice",
        "policy_lookup",
        "validate_invoice",
        "check_amount",
        "approval_1",
        "post_to_erp",
        "end_1",
      ),
      edges: edges(
        ["start_1", "extract_invoice"],
        ["extract_invoice", "policy_lookup"],
        ["policy_lookup", "validate_invoice"],
        ["validate_invoice", "check_amount"],
        ["check_amount", "approval_1"],
        ["check_amount", "post_to_erp"],
        ["approval_1", "post_to_erp"],
        ["post_to_erp", "end_1"],
      ),
    });

    const seen = new Set(Object.values(positions).map((point) => `${point.x},${point.y}`));
    expect(seen.size).toBe(8);
    // The approval gate branches off the spine, so it must not share the
    // amount check's row and must land before the ERP write.
    expect(layerOf(positions, "approval_1")).toBe(5);
    expect(layerOf(positions, "post_to_erp")).toBe(6);
    expect(positions.approval_1.y).not.toBe(positions.check_amount.y);
  });
});

describe("looksVertical", () => {
  const at = (id: string, x: number, y: number) => ({ id, position: { x, y } });

  it("is false for a graph too small to judge", () => {
    expect(looksVertical([at("a", 0, 0), at("b", 0, 120)])).toBe(false);
  });

  it("detects a top-to-bottom arrangement", () => {
    expect(looksVertical([at("a", 40, 0), at("b", 40, 140), at("c", 40, 280)])).toBe(true);
  });

  it("is false for the seeded horizontal graphs", () => {
    // Demo graphs ship at x = 0, 220, 440… — they are already left-to-right and
    // must never be offered a re-layout as though they were legacy.
    expect(looksVertical([at("a", 0, 240), at("b", 220, 240), at("c", 440, 240)])).toBe(false);
  });

  it("is false when nodes are scattered", () => {
    expect(looksVertical([at("a", 0, 0), at("b", 400, 90), at("c", 180, 300)])).toBe(false);
  });

  it("is false when everything sits on one point", () => {
    expect(looksVertical([at("a", 0, 0), at("b", 0, 0), at("c", 0, 0)])).toBe(false);
  });
});
