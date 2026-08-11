import { describe, expect, it } from "vitest";

import {
  FILM_BEATS,
  FILM_NODES,
  beatIndexAtProgress,
  nodeStatesAtBeat,
  runStatusLabel,
} from "./run-film";

describe("beatIndexAtProgress", () => {
  it("maps the ends of the scrub onto the first and last beat", () => {
    expect(beatIndexAtProgress(0)).toBe(0);
    expect(beatIndexAtProgress(1)).toBe(FILM_BEATS.length - 1);
  });

  it("clamps out-of-range progress instead of throwing", () => {
    // ScrollTrigger can momentarily report <0 or >1 during a resize or fling.
    expect(beatIndexAtProgress(-0.4)).toBe(0);
    expect(beatIndexAtProgress(1.8)).toBe(FILM_BEATS.length - 1);
    expect(beatIndexAtProgress(Number.NaN)).toBe(0);
  });

  it("never returns an index past the end", () => {
    for (let p = 0; p <= 1.0001; p += 0.017) {
      const index = beatIndexAtProgress(p);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(FILM_BEATS.length);
    }
  });

  it("advances monotonically", () => {
    let previous = -1;
    for (let p = 0; p <= 1; p += 0.01) {
      const index = beatIndexAtProgress(p);
      expect(index).toBeGreaterThanOrEqual(previous);
      previous = index;
    }
  });
});

describe("nodeStatesAtBeat", () => {
  it("starts with every node pending except the first", () => {
    const states = nodeStatesAtBeat(0);
    expect(states.invoice_received).toBe("succeeded");
    expect(states.extract_invoice).toBe("pending");
    expect(states.run_complete).toBe("pending");
  });

  it("holds the approval node in `waiting`, not `running`", () => {
    // The gate is the film's argument: it is paused, not working.
    const approvalIndex = FILM_BEATS.findIndex((b) => b.id === "approval");
    const states = nodeStatesAtBeat(approvalIndex);
    expect(states.approval_1).toBe("waiting");
  });

  it("leaves the mutating tool node pending while approval is waiting", () => {
    // Mirrors the engine: `human_approval` interrupts before the downstream
    // tool node is ever invoked. If this ever reads `running`, the film is
    // claiming the ERP was written to before a human approved.
    const approvalIndex = FILM_BEATS.findIndex((b) => b.id === "approval");
    expect(nodeStatesAtBeat(approvalIndex).post_to_erp).toBe("pending");
  });

  it("promotes an earlier multi-beat node to succeeded once passed", () => {
    // `extract_invoice` owns two beats (thinking, then output).
    const thinking = FILM_BEATS.findIndex((b) => b.id === "agent-thinking");
    const output = FILM_BEATS.findIndex((b) => b.id === "agent-output");
    expect(nodeStatesAtBeat(thinking).extract_invoice).toBe("running");
    expect(nodeStatesAtBeat(output).extract_invoice).toBe("succeeded");
  });

  it("marks everything succeeded on the final beat", () => {
    const states = nodeStatesAtBeat(FILM_BEATS.length - 1);
    for (const node of FILM_NODES) {
      expect(states[node.key]).toBe("succeeded");
    }
  });

  it("clamps an out-of-range beat index", () => {
    expect(() => nodeStatesAtBeat(-3)).not.toThrow();
    expect(() => nodeStatesAtBeat(999)).not.toThrow();
    expect(nodeStatesAtBeat(999).run_complete).toBe("succeeded");
  });
});

describe("film script integrity", () => {
  it("references only nodes that exist in the chain", () => {
    const keys = new Set(FILM_NODES.map((n) => n.key));
    for (const beat of FILM_BEATS) {
      expect(keys.has(beat.nodeKey)).toBe(true);
    }
  });

  it("visits nodes in chain order", () => {
    const order = FILM_NODES.map((n) => n.key);
    let cursor = 0;
    for (const beat of FILM_BEATS) {
      const position = order.indexOf(beat.nodeKey);
      expect(position).toBeGreaterThanOrEqual(cursor);
      cursor = position;
    }
  });

  it("uses beat ids that are unique", () => {
    const ids = FILM_BEATS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("labels every reachable run status", () => {
    for (const beat of FILM_BEATS) {
      expect(runStatusLabel(beat.runStatus)).toBeTruthy();
    }
  });
});
