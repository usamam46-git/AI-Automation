import { describe, expect, it } from "vitest";
import {
  ARRAY_PREVIEW_LIMIT,
  countFields,
  describeValue,
  formatJson,
  formatScalar,
  jsonKind,
  toTable,
} from "@/lib/data-preview";

/** Flatten a preview tree to the paths it offers. */
function paths(nodes: ReturnType<typeof describeValue>): string[] {
  return nodes.flatMap((node) => [node.path, ...paths(node.children)]);
}

describe("jsonKind", () => {
  it("classifies every JSON type", () => {
    expect(jsonKind("a")).toBe("string");
    expect(jsonKind(1)).toBe("number");
    expect(jsonKind(true)).toBe("boolean");
    expect(jsonKind(null)).toBe("null");
    expect(jsonKind([])).toBe("array");
    expect(jsonKind({})).toBe("object");
  });

  it("treats undefined as null — JSON has no undefined", () => {
    expect(jsonKind(undefined)).toBe("null");
  });
});

describe("describeValue", () => {
  it("returns nothing for a scalar", () => {
    expect(describeValue(42, "trigger_payload")).toEqual([]);
  });

  it("builds dotted paths under the root", () => {
    const nodes = describeValue({ vendor: "Acme", total: 4200 }, "node_outputs.extract");
    expect(nodes.map((node) => node.path)).toEqual([
      "node_outputs.extract.vendor",
      "node_outputs.extract.total",
    ]);
  });

  it("addresses array items by INTEGER INDEX, matching resolve_field_path", () => {
    const nodes = describeValue({ hits: [{ score: 0.9 }] }, "node_outputs.policy_lookup");
    expect(paths(nodes)).toContain("node_outputs.policy_lookup.hits.0.score");
  });

  it("descends into nested objects", () => {
    const nodes = describeValue({ body: { data: { id: 7 } } }, "node_outputs.fetch");
    expect(paths(nodes)).toContain("node_outputs.fetch.body.data.id");
  });

  it("caps how many array items it expands", () => {
    const items = Array.from({ length: 20 }, (_, index) => ({ index }));
    const nodes = describeValue({ items }, "root");
    expect(nodes[0].children).toHaveLength(ARRAY_PREVIEW_LIMIT);
  });

  it("stops at a depth bound rather than trusting the payload", () => {
    // 10 levels deep; the walk must not produce all of them.
    let deep: unknown = { leaf: 1 };
    for (let level = 0; level < 10; level += 1) deep = { nested: deep };
    const deepest = paths(describeValue(deep, "root")).reduce((a, b) => (a.length > b.length ? a : b));
    expect(deepest.split(".").length).toBeLessThanOrEqual(7);
  });

  it("marks a key containing a dot as unaddressable", () => {
    // resolve_field_path splits on "." — `{"a.b": 1}` can never be reached.
    const [node] = describeValue({ "a.b": 1 }, "trigger_payload");
    expect(node.addressable).toBe(false);
  });

  it("inherits unaddressability down the tree", () => {
    const [parent] = describeValue({ "a.b": { fine: 1 } }, "trigger_payload");
    expect(parent.children[0].key).toBe("fine");
    expect(parent.children[0].addressable).toBe(false);
  });

  it("keeps ordinary siblings addressable", () => {
    const nodes = describeValue({ "a.b": 1, ok: 2 }, "trigger_payload");
    expect(nodes.map((node) => node.addressable)).toEqual([false, true]);
  });

  it("carries the raw value through for rendering", () => {
    const [node] = describeValue({ total: 4200 }, "root");
    expect(node.value).toBe(4200);
    expect(node.kind).toBe("number");
  });
});

describe("toTable", () => {
  it("renders an object as a single row", () => {
    expect(toTable({ vendor: "Acme", total: 4200 })).toEqual({
      columns: ["vendor", "total"],
      rows: [{ vendor: "Acme", total: 4200 }],
    });
  });

  it("renders an array of objects as one row each", () => {
    const table = toTable([{ a: 1 }, { a: 2 }]);
    expect(table?.rows).toHaveLength(2);
    expect(table?.columns).toEqual(["a"]);
  });

  it("takes the UNION of keys, so a field only some rows carry survives", () => {
    expect(toTable([{ a: 1 }, { b: 2 }])?.columns).toEqual(["a", "b"]);
  });

  it("handles an empty array", () => {
    expect(toTable([])).toEqual({ columns: [], rows: [] });
  });

  it("refuses an array of scalars rather than inventing a column", () => {
    expect(toTable([1, 2, 3])).toBeNull();
  });

  it("refuses a mixed array", () => {
    expect(toTable([{ a: 1 }, 2])).toBeNull();
  });

  it("refuses a bare scalar", () => {
    expect(toTable("hello")).toBeNull();
    expect(toTable(null)).toBeNull();
  });
});

describe("formatScalar", () => {
  it("renders scalars plainly", () => {
    expect(formatScalar("Acme")).toBe("Acme");
    expect(formatScalar(4200)).toBe("4200");
    expect(formatScalar(false)).toBe("false");
    expect(formatScalar(null)).toBe("null");
  });

  it("summarises containers with a correctly pluralised count", () => {
    expect(formatScalar([1])).toBe("[ 1 item ]");
    expect(formatScalar([1, 2])).toBe("[ 2 items ]");
    expect(formatScalar({ a: 1 })).toBe("{ 1 key }");
    expect(formatScalar({ a: 1, b: 2 })).toBe("{ 2 keys }");
  });
});

describe("formatJson", () => {
  it("pretty-prints", () => {
    expect(formatJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("never throws on a value that cannot be serialised", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => formatJson(cyclic)).not.toThrow();
  });
});

describe("countFields", () => {
  it("counts leaves, not branches", () => {
    expect(countFields(describeValue({ a: 1, b: { c: 2, d: 3 } }, "root"))).toBe(3);
  });

  it("counts an empty container as one field", () => {
    expect(countFields(describeValue({ a: {} }, "root"))).toBe(1);
  });
});
