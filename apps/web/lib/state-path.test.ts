import { describe, expect, it } from "vitest";
import { ancestorsOf, checkStatePath, STATE_ROOTS } from "@/lib/state-path";

const context = (nodeKeys: string[], ancestors: string[]) => ({
  nodeKeys: new Set(nodeKeys),
  ancestors: new Set(ancestors),
});

describe("checkStatePath", () => {
  it("accepts a blank path — an empty field is not an error", () => {
    expect(checkStatePath("")).toBeNull();
    expect(checkStatePath("   ")).toBeNull();
  });

  it("accepts every documented state root", () => {
    // `node_outputs` is excluded on purpose: it is a real root but not a usable
    // path on its own — it needs a step key after it, which is its own check.
    for (const root of STATE_ROOTS) {
      if (root === "node_outputs") continue;
      expect(checkStatePath(root)).toBeNull();
    }
  });

  it("flags an unknown root", () => {
    expect(checkStatePath("outputs.extract.vendor")?.message).toContain('"outputs" is not a state root');
  });

  it("accepts a non-node_outputs root without needing graph context", () => {
    expect(checkStatePath("trigger_payload.invoice.total")).toBeNull();
  });

  it("asks for a step key after node_outputs", () => {
    expect(checkStatePath("node_outputs")?.message).toContain("needs a step key");
  });

  it("says nothing further without graph context", () => {
    // Honest silence: with no graph there is no way to know if the key is real.
    expect(checkStatePath("node_outputs.whatever.field")).toBeNull();
  });

  it("flags a step that is not on the canvas", () => {
    const problem = checkStatePath("node_outputs.typo.vendor", context(["extract"], ["extract"]));
    expect(problem?.message).toContain('No step named "typo"');
  });

  it("flags a FORWARD reference — the silent failure nothing else catches", () => {
    // Syntactically perfect, resolves to null every run, reported by nothing.
    const problem = checkStatePath("node_outputs.post.confirmation_id", context(["post", "extract"], ["extract"]));
    expect(problem?.message).toContain("does not run before this step");
  });

  it("accepts a genuine upstream reference", () => {
    expect(checkStatePath("node_outputs.extract.vendor", context(["extract", "post"], ["extract"]))).toBeNull();
  });

  it("only ever warns — it never blocks", () => {
    expect(checkStatePath("nonsense.path")?.level).toBe("warning");
  });

  it("returns one problem, not a pile", () => {
    const problem = checkStatePath("node_outputs.typo", context(["extract"], ["extract"]));
    expect(problem).not.toBeNull();
    expect(Array.isArray(problem)).toBe(false);
  });
});

describe("ancestorsOf", () => {
  const edge = (source: string, target: string) => ({ source, target });

  it("finds a direct predecessor", () => {
    expect([...ancestorsOf("b", [edge("a", "b")])]).toEqual(["a"]);
  });

  it("walks the whole chain, not just one step", () => {
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "d")];
    expect([...ancestorsOf("d", edges)].sort()).toEqual(["a", "b", "c"]);
  });

  it("collects every branch that converges", () => {
    const edges = [edge("a", "c"), edge("b", "c")];
    expect([...ancestorsOf("c", edges)].sort()).toEqual(["a", "b"]);
  });

  it("returns nothing for a start node", () => {
    expect([...ancestorsOf("a", [edge("a", "b")])]).toEqual([]);
  });

  it("terminates on a cycle — the canvas holds invalid drafts constantly", () => {
    const edges = [edge("a", "b"), edge("b", "a")];
    expect([...ancestorsOf("a", edges)].sort()).toEqual(["a", "b"]);
  });

  it("excludes nodes that are only downstream", () => {
    const edges = [edge("a", "b"), edge("b", "c")];
    expect(ancestorsOf("b", edges).has("c")).toBe(false);
  });
});
