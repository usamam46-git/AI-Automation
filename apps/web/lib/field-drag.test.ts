import { describe, expect, it } from "vitest";
import {
  applyPathToFieldMap,
  applyPathToList,
  destinationKeyFor,
  parseFieldDrag,
  serializeFieldDrag,
} from "@/lib/field-drag";

describe("serializeFieldDrag / parseFieldDrag", () => {
  it("round-trips a payload", () => {
    const payload = { path: "node_outputs.extract.vendor", key: "vendor", kind: "string" as const };
    expect(parseFieldDrag(serializeFieldDrag(payload))).toEqual(payload);
  });

  it("ignores a foreign drag rather than throwing", () => {
    // The canvas also carries the node-palette drag; a drop handler sees both.
    expect(parseFieldDrag("not json")).toBeNull();
    expect(parseFieldDrag("")).toBeNull();
    expect(parseFieldDrag(null)).toBeNull();
    expect(parseFieldDrag(undefined)).toBeNull();
  });

  it("rejects a payload with no usable path", () => {
    expect(parseFieldDrag(JSON.stringify({ key: "vendor" }))).toBeNull();
    expect(parseFieldDrag(JSON.stringify({ path: "   " }))).toBeNull();
  });

  it("recovers a missing key from the path", () => {
    expect(parseFieldDrag(JSON.stringify({ path: "a.b.total" }))?.key).toBe("total");
  });
});

describe("destinationKeyFor", () => {
  it("uses the leaf segment", () => {
    expect(destinationKeyFor("node_outputs.extract.vendor_name")).toBe("vendor_name");
  });

  it("skips an array index — '0' is a useless field name", () => {
    expect(destinationKeyFor("node_outputs.lookup.hits.0")).toBe("hits");
  });

  it("keeps the leaf when it merely follows an index", () => {
    expect(destinationKeyFor("node_outputs.lookup.hits.0.content")).toBe("content");
  });

  it("skips a negative index too", () => {
    expect(destinationKeyFor("node_outputs.fetch.body.-1")).toBe("body");
  });

  it("reduces characters a key may not contain", () => {
    expect(destinationKeyFor("trigger_payload.some-field!")).toBe("some_field");
  });

  it("falls back to a usable name rather than an empty key", () => {
    expect(destinationKeyFor("")).toBe("value");
    expect(destinationKeyFor("trigger_payload.---")).toBe("value");
  });
});

describe("applyPathToFieldMap", () => {
  it("adds the path under its suggested key", () => {
    expect(applyPathToFieldMap({}, "node_outputs.extract.vendor")).toEqual({
      next: { vendor: "node_outputs.extract.vendor" },
      key: "vendor",
    });
  });

  it("never overwrites an existing mapping", () => {
    // Dropping a second field must not silently replace the first.
    const result = applyPathToFieldMap({ vendor: "trigger_payload.vendor" }, "node_outputs.extract.vendor");
    expect(result.key).toBe("vendor_2");
    expect(result.next).toEqual({
      vendor: "trigger_payload.vendor",
      vendor_2: "node_outputs.extract.vendor",
    });
  });

  it("keeps counting past the first collision", () => {
    const map = { vendor: "a", vendor_2: "b" };
    expect(applyPathToFieldMap(map, "node_outputs.x.vendor").key).toBe("vendor_3");
  });

  it("leaves the original map untouched", () => {
    const map = { vendor: "a" };
    applyPathToFieldMap(map, "node_outputs.x.total");
    expect(map).toEqual({ vendor: "a" });
  });
});

describe("applyPathToList", () => {
  it("appends a new path", () => {
    expect(applyPathToList(["trigger_payload"], "node_outputs.extract")).toEqual([
      "trigger_payload",
      "node_outputs.extract",
    ]);
  });

  it("is a no-op for a duplicate", () => {
    expect(applyPathToList(["trigger_payload"], "trigger_payload")).toEqual(["trigger_payload"]);
  });

  it("returns a new array rather than mutating", () => {
    const list = ["trigger_payload"];
    expect(applyPathToList(list, "x")).not.toBe(list);
    expect(list).toEqual(["trigger_payload"]);
  });
});
