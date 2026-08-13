import { describe, expect, it } from "vitest";

import {
  CAMERA_KEYS,
  CLUSTER_CENTERS,
  LAYOUT_SEED,
  SCENES,
  SCENE_NODES,
  backdropGradientAtProgress,
  cameraAtProgress,
  coreIntensityAtProgress,
  roomDepthAtProgress,
  sceneIndexAtProgress,
  sceneLocalProgress,
  settleAtProgress,
  smoothstep,
} from "./scene-script";

describe("SCENES", () => {
  it("covers the whole scrub with no gap or overlap", () => {
    expect(SCENES[0].start).toBe(0);
    expect(SCENES[SCENES.length - 1].end).toBe(1);
    for (let i = 0; i < SCENES.length - 1; i += 1) {
      expect(SCENES[i].end).toBe(SCENES[i + 1].start);
    }
  });

  it("gives the run scene the most scroll", () => {
    // Scene 3 carries the product's actual argument. If a later re-tune ever
    // makes another scene longer, that is a decision worth making on purpose.
    const spans = SCENES.map((s) => s.end - s.start);
    const runIndex = SCENES.findIndex((s) => s.id === "run");
    expect(Math.max(...spans)).toBe(spans[runIndex]);
  });
});

describe("sceneIndexAtProgress", () => {
  it("resolves each scene's own range", () => {
    expect(SCENES[sceneIndexAtProgress(0)].id).toBe("scattered");
    expect(SCENES[sceneIndexAtProgress(0.4)].id).toBe("connect");
    expect(SCENES[sceneIndexAtProgress(0.7)].id).toBe("run");
    expect(SCENES[sceneIndexAtProgress(0.95)].id).toBe("orchestrated");
  });

  it("puts a boundary value in the later scene", () => {
    expect(SCENES[sceneIndexAtProgress(0.28)].id).toBe("connect");
    expect(SCENES[sceneIndexAtProgress(0.52)].id).toBe("run");
  });

  it("clamps rather than throwing on out-of-range scrub", () => {
    // ScrollTrigger reports these during a resize or a fast fling.
    expect(sceneIndexAtProgress(-0.4)).toBe(0);
    expect(sceneIndexAtProgress(1.6)).toBe(SCENES.length - 1);
    expect(sceneIndexAtProgress(Number.NaN)).toBe(0);
  });
});

describe("sceneLocalProgress", () => {
  it("runs 0→1 inside a scene", () => {
    expect(sceneLocalProgress(0)).toBeCloseTo(0);
    expect(sceneLocalProgress(0.14)).toBeCloseTo(0.5);
    expect(sceneLocalProgress(0.28)).toBeCloseTo(0);
    expect(sceneLocalProgress(1)).toBeCloseTo(1);
  });
});

describe("cameraAtProgress", () => {
  it("returns the first and last keys at the ends", () => {
    expect(cameraAtProgress(0).position).toEqual(CAMERA_KEYS[0].position);
    expect(cameraAtProgress(1).position).toEqual(CAMERA_KEYS[CAMERA_KEYS.length - 1].position);
  });

  it("hits every authored keyframe exactly", () => {
    for (const key of CAMERA_KEYS) {
      const got = cameraAtProgress(key.at);
      got.position.forEach((v, i) => expect(v).toBeCloseTo(key.position[i], 5));
      got.target.forEach((v, i) => expect(v).toBeCloseTo(key.target[i], 5));
    }
  });

  it("is continuous — no jump cuts anywhere on the path", () => {
    // A discontinuity is a camera that teleports mid-scroll: the single most
    // obvious way for the whole scene to look broken. This is deliberately a
    // *relative* check rather than a speed limit — the final pull-back is
    // legitimately the fastest move on the path, and an absolute threshold
    // would either fail on it or be too loose to catch a real seam elsewhere.
    const steps: number[] = [];
    let previous = cameraAtProgress(0).position;
    for (let p = 0.005; p <= 1; p += 0.005) {
      const current = cameraAtProgress(p).position;
      steps.push(
        Math.hypot(current[0] - previous[0], current[1] - previous[1], current[2] - previous[2]),
      );
      previous = current;
    }

    // Measured against the total path length rather than the median step, so
    // the assertion stays about *discontinuity* and not about pacing. The
    // median-based version had to be retuned every time a keyframe moved,
    // which makes it a test of the current camera rather than of correctness.
    const total = steps.reduce((sum, step) => sum + step, 0);
    expect(total).toBeGreaterThan(0);
    expect(Math.max(...steps)).toBeLessThan(total * 0.06);
  });

  it("clamps out-of-range scrub to the path ends", () => {
    expect(cameraAtProgress(-1).position).toEqual(CAMERA_KEYS[0].position);
    expect(cameraAtProgress(2).position).toEqual(CAMERA_KEYS[CAMERA_KEYS.length - 1].position);
  });
});

describe("roomDepthAtProgress", () => {
  it("runs the length of the page, not just scene 1", () => {
    expect(roomDepthAtProgress(0)).toBeCloseTo(0);
    expect(roomDepthAtProgress(1)).toBeCloseTo(1);
    expect(roomDepthAtProgress(0.5)).toBeGreaterThan(0);
    expect(roomDepthAtProgress(0.5)).toBeLessThan(1);
  });

  it("never goes backwards", () => {
    let previous = -1;
    for (let p = 0; p <= 1; p += 0.01) {
      const value = roomDepthAtProgress(p);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });
});

describe("coreIntensityAtProgress", () => {
  it("stays dormant through the opening of scene 1", () => {
    // Scene 1 claims nothing is connecting the work. A core already glowing in
    // the first frame contradicts that before the copy can make the point.
    expect(coreIntensityAtProgress(0)).toBe(0);
    expect(coreIntensityAtProgress(0.15)).toBe(0);
  });

  it("is fully lit shortly after scene 2 begins", () => {
    expect(coreIntensityAtProgress(SCENES[1].start)).toBeGreaterThan(0.4);
    expect(coreIntensityAtProgress(0.36)).toBeCloseTo(1);
    expect(coreIntensityAtProgress(1)).toBeCloseTo(1);
  });

  it("never dims once lit", () => {
    let previous = -1;
    for (let p = 0; p <= 1; p += 0.01) {
      const value = coreIntensityAtProgress(p);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });
});

describe("backdropGradientAtProgress", () => {
  it("stays a light daylight room from end to end", () => {
    // The scene is lit paper on warm studio grey. A dark background here was
    // tried and rejected: it read as a generic AI nebula and left no room for
    // the actual subject, which is readable documents. Every channel at every
    // sampled point must stay bright.
    expect(backdropGradientAtProgress(0)).toContain("rgb(240, 238, 233)");
    expect(backdropGradientAtProgress(1)).toContain("rgb(212, 208, 200)");

    for (let p = 0; p <= 1; p += 0.05) {
      // Match the rgb() triples only — a bare digit scan also picks up the
      // "180deg" in the gradient's angle.
      for (const match of backdropGradientAtProgress(p).matchAll(/rgb\((\d+), (\d+), (\d+)\)/g)) {
        for (const channel of match.slice(1)) expect(Number(channel)).toBeGreaterThan(180);
      }
    }
  });

  it("is a valid CSS gradient at every sampled point", () => {
    for (let p = 0; p <= 1; p += 0.05) {
      expect(backdropGradientAtProgress(p)).toMatch(
        /^linear-gradient\(180deg, rgb\(\d+, \d+, \d+\) 0%, rgb\(\d+, \d+, \d+\) 100%\)$/,
      );
    }
  });
});

describe("settleAtProgress", () => {
  it("holds still through the run scene", () => {
    // While the camera follows one run, the rest of the world must not move —
    // a busy background steals the weight from the approval hold.
    const start = settleAtProgress(0.52);
    const end = settleAtProgress(0.82);
    expect(start).toBeCloseTo(end, 6);
    expect(settleAtProgress(0.7)).toBeCloseTo(start, 6);
  });

  it("runs 0 at the start to 1 at the end, monotonically", () => {
    expect(settleAtProgress(0)).toBeCloseTo(0);
    expect(settleAtProgress(1)).toBeCloseTo(1);
    let previous = -1;
    for (let p = 0; p <= 1; p += 0.01) {
      const value = settleAtProgress(p);
      expect(value).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = value;
    }
  });
});

describe("SCENE_NODES", () => {
  it("is deterministic for a given seed", () => {
    // Any drift here is a hydration mismatch on the real page.
    expect(LAYOUT_SEED).toBe(0x6b357);
    expect(SCENE_NODES[0].scattered).toEqual(SCENE_NODES[0].scattered);
    expect(SCENE_NODES.map((n) => n.id)).toMatchSnapshot();
    expect(SCENE_NODES.map((n) => n.scattered.map((v) => Number(v.toFixed(4))))).toMatchSnapshot();
  });

  it("has unique ids", () => {
    expect(new Set(SCENE_NODES.map((n) => n.id)).size).toBe(SCENE_NODES.length);
  });

  it("keeps the scattered field clear of the core and inside the frustum", () => {
    for (const node of SCENE_NODES) {
      const r = Math.hypot(...node.scattered);
      expect(r).toBeGreaterThan(6);
      expect(r).toBeLessThan(32);
    }
  });

  it("settles every node near its own cluster centre", () => {
    for (const node of SCENE_NODES) {
      const centre = CLUSTER_CENTERS[node.cluster];
      const distance = Math.hypot(
        node.home[0] - centre[0],
        node.home[1] - centre[1],
        node.home[2] - centre[2],
      );
      expect(distance).toBeLessThan(9);
    }
  });

  it("populates all four clusters", () => {
    const clusters = new Set(SCENE_NODES.map((n) => n.cluster));
    expect([...clusters].sort()).toEqual(["erp", "finance", "hr", "people"]);
  });
});

describe("smoothstep", () => {
  it("clamps and eases", () => {
    expect(smoothstep(-1)).toBe(0);
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(0.5)).toBe(0.5);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(4)).toBe(1);
  });
});
