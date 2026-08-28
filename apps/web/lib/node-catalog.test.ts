import { describe, expect, it } from "vitest";
import type { NodeType } from "@/lib/api";
import { NODE_CATALOG, PALETTE_ORDER, nextNodeKey, searchNodeCatalog } from "@/lib/node-catalog";

/** Flatten the grouped result to the node types it offers, in order. */
function typesFrom(groups: ReturnType<typeof searchNodeCatalog>): NodeType[] {
  return groups.flatMap((group) => group.entries.map((entry) => entry.type));
}

describe("searchNodeCatalog", () => {
  it("offers every node type when the query is blank", () => {
    expect(typesFrom(searchNodeCatalog("")).sort()).toEqual([...PALETTE_ORDER].sort());
  });

  it("ignores surrounding whitespace", () => {
    expect(typesFrom(searchNodeCatalog("   "))).toEqual(typesFrom(searchNodeCatalog("")));
  });

  it("groups results in the documented category order", () => {
    expect(searchNodeCatalog("").map((group) => group.category)).toEqual(["Trigger", "AI", "Actions", "Flow"]);
  });

  it("drops categories with no match rather than rendering an empty heading", () => {
    expect(searchNodeCatalog("approve").map((group) => group.category)).toEqual(["Flow"]);
  });

  it("matches on the label", () => {
    expect(typesFrom(searchNodeCatalog("agent"))).toEqual(["agent"]);
  });

  it("is case-insensitive", () => {
    expect(typesFrom(searchNodeCatalog("AGENT"))).toEqual(["agent"]);
  });

  it("ranks an exact keyword above an accidental substring", () => {
    // "if" is a keyword on Condition, but it is also buried inside Agent's
    // "classify" and Tool's "notify". Plain substring matching put Agent first,
    // which reads as the search guessing.
    expect(typesFrom(searchNodeCatalog("if"))[0]).toBe("condition");
  });

  it("puts the category someone meant first", () => {
    expect(searchNodeCatalog("if")[0].category).toBe("Flow");
  });

  it("ranks an exact label above everything", () => {
    expect(typesFrom(searchNodeCatalog("tool"))[0]).toBe("tool");
  });

  it("ranks a label prefix above a keyword hit", () => {
    // "Condition" starts with "cond"; nothing else has it as a keyword.
    expect(typesFrom(searchNodeCatalog("cond"))[0]).toBe("condition");
  });

  it("keeps the documented category order when nothing is typed", () => {
    // A blank query scores every entry equally, so the stable sort must leave
    // both the groups and the palette order alone.
    expect(searchNodeCatalog("").map((group) => group.category)).toEqual(["Trigger", "AI", "Actions", "Flow"]);
    // Category order wins over the flat palette order — `subgraph` is an Action
    // and so precedes the Flow types, which it does not in PALETTE_ORDER. Within
    // each group the palette order is what survives.
    expect(typesFrom(searchNodeCatalog(""))).toEqual([
      "start",
      "agent",
      "tool",
      "subgraph",
      "condition",
      "human_approval",
      "end",
    ]);
  });

  it("finds a node by the word a newcomer would actually type", () => {
    // None of these three words appear in the labels.
    expect(typesFrom(searchNodeCatalog("if"))).toContain("condition");
    expect(typesFrom(searchNodeCatalog("gpt"))).toContain("agent");
    expect(typesFrom(searchNodeCatalog("api"))).toContain("tool");
  });

  it("requires every term to match, so extra words narrow the list", () => {
    const broad = typesFrom(searchNodeCatalog("workflow"));
    const narrow = typesFrom(searchNodeCatalog("workflow nested"));
    expect(narrow.length).toBeLessThanOrEqual(broad.length);
    expect(narrow).toEqual(["subgraph"]);
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(searchNodeCatalog("kubernetes")).toEqual([]);
  });

  it("excludes Start when the new node must accept an incoming edge", () => {
    // Adding off another node's output handle: `start` has no input handle, so
    // the edge the gesture promises could not exist.
    const offered = typesFrom(searchNodeCatalog("", { needsTarget: true }));
    expect(offered).not.toContain("start");
    expect(offered).toContain("end");
  });

  it("excludes End as well when the node is being inserted into an edge", () => {
    const offered = typesFrom(searchNodeCatalog("", { needsTarget: true, needsSource: true }));
    expect(offered).not.toContain("start");
    expect(offered).not.toContain("end");
    expect(offered).toContain("agent");
  });

  it("applies the handle filter alongside the query", () => {
    expect(typesFrom(searchNodeCatalog("trigger", { needsTarget: true }))).toEqual([]);
  });
});

describe("catalog integrity", () => {
  it("lists every node type in the palette order exactly once", () => {
    const keys = Object.keys(NODE_CATALOG) as NodeType[];
    expect([...PALETTE_ORDER].sort()).toEqual([...keys].sort());
    expect(new Set(PALETTE_ORDER).size).toBe(PALETTE_ORDER.length);
  });

  it("gives every entry a category and at least one keyword", () => {
    for (const entry of Object.values(NODE_CATALOG)) {
      expect(entry.category).toBeTruthy();
      expect(entry.keywords.length).toBeGreaterThan(0);
    }
  });

  it("keeps Start and End as the only one-sided node types", () => {
    // The picker's handle filters are derived from these two flags, so a change
    // here silently changes what the ⊕ gesture offers.
    expect(NODE_CATALOG.start.hasTarget).toBe(false);
    expect(NODE_CATALOG.end.hasSource).toBe(false);
    for (const entry of Object.values(NODE_CATALOG)) {
      if (entry.type === "start" || entry.type === "end") continue;
      expect(entry.hasSource && entry.hasTarget).toBe(true);
    }
  });
});

describe("nextNodeKey", () => {
  it("starts at 1", () => {
    expect(nextNodeKey("agent", [])).toBe("agent_1");
  });

  it("skips keys already on the canvas", () => {
    expect(nextNodeKey("agent", ["agent_1", "agent_2"])).toBe("agent_3");
  });

  it("fills the first free slot rather than appending", () => {
    expect(nextNodeKey("agent", ["agent_1", "agent_3"])).toBe("agent_2");
  });

  it("uses the type's own prefix, not its label", () => {
    expect(nextNodeKey("human_approval", [])).toBe("approval_1");
  });
});
