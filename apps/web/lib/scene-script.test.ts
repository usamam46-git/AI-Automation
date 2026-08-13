import { describe, expect, it } from "vitest";

import { FILM_BEATS } from "./run-film";
import {
  CAMERA_KEYS,
  CARD_WORLD_WIDTH,
  CLUSTER_CENTERS,
  CLUSTER_LABELS,
  CARD_REST_Y,
  DESK_Y,
  LIFTOFF_END,
  MARK_NODES,
  CORE_ENDPOINT,
  COPY_SAFE_ZONE,
  HERO_CTA_CHANNEL,
  HERO_SAFE_ZONE,
  LAYOUT_PROGRESS,
  LAYOUT_SEED,
  MIN_SCREEN_GAP,
  SCENES,
  RUN_CHAIN,
  SCENE_EDGES,
  SCENE_NODES,
  backdropGradientAtProgress,
  cameraAtProgress,
  cardDrawnSize,
  cardFootprint,
  cardPositionAt,
  cardRotationAt,
  clusterLabelOpacityAtProgress,
  deskLiftAtProgress,
  deskPresenceAtProgress,
  coreIntensityAtProgress,
  coreVisibilityAtProgress,
  documentPresenceAtProgress,
  edgeRevealAtProgress,
  erpWrittenAtProgress,
  focusedDocumentAtProgress,
  heldAtGateAtProgress,
  framing,
  heroOpacityAtProgress,
  intersectsCopyZone,
  intersectsHeroZone,
  isVisibleAtOpening,
  markCollapseAtProgress,
  markTargetFor,
  projectAtProgress,
  roomDepthAtProgress,
  runBeatAtProgress,
  runBeatIndexAtProgress,
  sceneCaptionOpacityAtProgress,
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
    // The page's own --mk-paper (#f5f5f7, macOS light mode) and --mk-mist
    // (#ececef). The scene must not introduce a background of its own, and the
    // greys must stay NEUTRAL — a warm grey on a page this light reads as beige.
    expect(backdropGradientAtProgress(0)).toContain("rgb(245, 245, 247)");
    expect(backdropGradientAtProgress(1)).toContain("rgb(232, 232, 236)");

    // Neutral means the blue channel never falls below the red one.
    for (let p = 0; p <= 1; p += 0.05) {
      for (const m of backdropGradientAtProgress(p).matchAll(/rgb\((\d+), (\d+), (\d+)\)/g)) {
        expect(Number(m[3]), "backdrop has a warm cast").toBeGreaterThanOrEqual(Number(m[1]));
      }
    }

    for (let p = 0; p <= 1; p += 0.05) {
      // Match the rgb() triples only — a bare digit scan also picks up the
      // "180deg" in the gradient's angle.
      for (const match of backdropGradientAtProgress(p).matchAll(/rgb\((\d+), (\d+), (\d+)\)/g)) {
        // Never leaves the near-white family the rest of the page lives in.
        for (const channel of match.slice(1)) expect(Number(channel)).toBeGreaterThan(230);
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

/** A desk document's footprint, matching what `placeOnDesk` enforces. */
function inflateDeskFootprint(node: (typeof SCENE_NODES)[number]) {
  const raw = projectAtProgress(node.desk, 0);
  const tanHalf = Math.tan((46 * Math.PI) / 360);
  return {
    ...raw,
    radiusY: raw.radiusY * node.scale + 0.8 / (raw.depth * tanHalf),
  };
}

/** The cards actually in frame at the opening — the field extends past it. */
function visibleAtOpening() {
  return SCENE_NODES.filter(isVisibleAtOpening).map((node) => cardFootprint(node, LAYOUT_PROGRESS));
}

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

  it("keeps the scattered field clear of the core", () => {
    for (const node of SCENE_NODES) {
      expect(Math.hypot(...node.scattered)).toBeGreaterThan(6);
    }
  });

  /**
   * These four are the composition, asserted rather than eyeballed.
   *
   * The first frame that was ever looked at failed three of them: cards packed
   * into the edges with a hole through the middle (a spherical shell projects
   * to an annulus), several clipped by the frame edge, and an employee record
   * sitting behind the words "Your company is already automated."
   */
  it("places nothing behind the opening copy block", () => {
    for (const node of SCENE_NODES) {
      const screen = cardFootprint(node, LAYOUT_PROGRESS);
      expect(
        intersectsCopyZone(screen),
        `${node.id} lands on the copy at (${screen.x.toFixed(2)}, ${screen.y.toFixed(2)})`,
      ).toBe(false);
    }
  });

  it("never slices a card on the frame edge", () => {
    // Wholly visible or wholly elsewhere. The in-between reads as a rendering
    // fault rather than as a world that continues past the viewport. Measured
    // against the drifted, scaled footprint — measuring the authored point
    // instead is what let the first fixed frame clip cards along the top.
    for (const node of SCENE_NODES) {
      const screen = cardFootprint(node, LAYOUT_PROGRESS);
      expect(screen.depth, `${node.id} is behind the camera`).toBeGreaterThan(2);
      expect(framing(screen), `${node.id} straddles the frame edge`).not.toBe("straddling");
    }
  });

  it("holds the composition across viewport widths, not just the composed one", () => {
    // `framing` judges "inside" at 3:2 and "outside" at 21:9 precisely so this
    // holds. Composing at a single aspect let cards parked off a 16:9 frame
    // reappear, clipped, in the corners of a wider window.
    for (const node of SCENE_NODES) {
      const screen = cardFootprint(node, LAYOUT_PROGRESS);
      const state = framing(screen);
      for (const aspect of [1.6, 1.78, 1.9, 2.4]) {
        const x = Math.abs(screen.x) * (1.78 / aspect);
        const rx = screen.radiusY / aspect;
        const visibleHere = x - rx < 1 && Math.abs(screen.y) - screen.radiusY < 1;
        if (state === "outside") {
          expect(visibleHere, `${node.id} reappears at aspect ${aspect}`).toBe(false);
        } else {
          expect(
            x + rx < 1.02 && Math.abs(screen.y) + screen.radiusY < 1.02,
            `${node.id} is clipped at aspect ${aspect}`,
          ).toBe(true);
        }
      }
    }
  });

  it("fills the centre of the opening frame rather than only its edges", () => {
    // The shell version left this region empty at every seed. At least a few
    // cards must read as being *in front of* the viewer, not around them.
    const central = visibleAtOpening().filter((screen) => Math.hypot(screen.x, screen.y) < 0.55);
    expect(central.length).toBeGreaterThanOrEqual(3);
  });

  it("shows a readable number of documents at once, not the whole roster", () => {
    // Twenty legible cards do not fit one frame; the field extends past the
    // viewport on purpose. This pins the opening to a countable composition
    // rather than a wall of paper.
    const visible = visibleAtOpening();
    expect(visible.length).toBeGreaterThanOrEqual(7);
    expect(visible.length).toBeLessThanOrEqual(14);
  });

  it("separates visible cards by their own on-screen size", () => {
    // A fixed gap would let two near cards overlap while holding two distant
    // ones needlessly apart. Measured on drawn size, not the drift footprint.
    const points = SCENE_NODES.filter(isVisibleAtOpening).map((node) => cardDrawnSize(node, LAYOUT_PROGRESS));
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const gap = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
        const required = Math.max(
          MIN_SCREEN_GAP,
          (points[i].radiusY + points[j].radiusY) * 0.82 + 0.05,
        );
        expect(gap).toBeGreaterThanOrEqual(required);
      }
    }
  });

  it("keeps the nearest cards large enough to actually read", () => {
    // The point of the whole document treatment. A card whose body copy does
    // not resolve is the abstract shape it replaced.
    //
    // Measured on the DRAWN size. An earlier version of this assertion used the
    // drift-inflated footprint and passed while every card on screen was in
    // fact too small and too far — the inflation, not the card, was carrying it.
    const tallest = Math.max(
      ...SCENE_NODES.filter(isVisibleAtOpening).map((node) => cardDrawnSize(node, LAYOUT_PROGRESS).radiusY),
    );
    // radiusY is the card's height as a fraction of the viewport, so 0.25 is
    // ~200px on an 800px-tall window.
    expect(tallest).toBeGreaterThan(0.25);
  });
});

describe("projectAtProgress", () => {
  it("puts the camera target at the centre of frame", () => {
    // Whatever the camera is looking at, at any progress, projects to (0, 0).
    for (const p of [0, LAYOUT_PROGRESS, 0.5, 0.7, 1]) {
      const { target } = cameraAtProgress(p);
      const screen = projectAtProgress(target, p);
      expect(Math.abs(screen.x)).toBeLessThan(0.001);
      expect(Math.abs(screen.y)).toBeLessThan(0.001);
      expect(screen.depth).toBeGreaterThan(0);
    }
  });

  it("reports points behind the camera as such instead of mirroring them", () => {
    const behind = projectAtProgress([0, 3, 90], LAYOUT_PROGRESS);
    expect(behind.depth).toBeLessThanOrEqual(0);
    expect(intersectsCopyZone(behind)).toBe(false);
  });

  it("shrinks a card with distance", () => {
    const near = projectAtProgress([0, 8, 10], LAYOUT_PROGRESS);
    const far = projectAtProgress([0, 8, -40], LAYOUT_PROGRESS);
    expect(near.radiusY).toBeGreaterThan(far.radiusY);
  });

  it("agrees with the copy zone it is compared against", () => {
    const inside = {
      x: 0,
      y: (COPY_SAFE_ZONE.minY + COPY_SAFE_ZONE.maxY) / 2,
      depth: 20,
      radiusY: 0.05,
    };
    expect(intersectsCopyZone(inside)).toBe(true);
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

describe("SCENE_EDGES", () => {
  const ids = new Set(SCENE_NODES.map((n) => n.id));

  it("only connects documents that exist", () => {
    // A typo here is an edge anchored at the origin, which reads as a stray
    // line shooting through the middle of the room.
    for (const edge of SCENE_EDGES) {
      for (const endpoint of [edge.from, edge.to]) {
        if (endpoint === CORE_ENDPOINT) continue;
        expect(ids.has(endpoint), `no document "${endpoint}"`).toBe(true);
      }
    }
  });

  it("never connects a document to itself", () => {
    for (const edge of SCENE_EDGES) expect(edge.from).not.toBe(edge.to);
  });

  it("has no duplicate connections", () => {
    const seen = SCENE_EDGES.map((e) => [e.from, e.to].sort().join("~"));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("traces the same document trail the cards and the run film pin", () => {
    // The scene, `document-cards.ts` and `run-film.ts` must tell one story.
    // This is the chain: PO-4471 -> GR-2214 -> INV-2291 -> gate -> JE-99120.
    const chain = SCENE_EDGES.filter((e) => e.kind === "chain");
    const has = (from: string, to: string) =>
      chain.some((e) => e.from === from && e.to === to);

    expect(has("purchase_order", "goods_receipt")).toBe(true);
    expect(has("goods_receipt", "vendor_invoice")).toBe(true);
    expect(has("vendor_invoice", "finance_approval")).toBe(true);
    expect(has("finance_approval", "journal_entry")).toBe(true);
  });

  it("routes the invoice to the ledger only through the approval gate", () => {
    // The load-bearing invariant, as a property of the graph rather than a
    // drawing: there must be no chain edge from the invoice straight to the
    // journal entry. If one is ever added, the scene is claiming the ERP can
    // be written to without a person, which is the opposite of the argument.
    const direct = SCENE_EDGES.some(
      (e) =>
        e.kind === "chain" &&
        ((e.from === "vendor_invoice" && e.to === "journal_entry") ||
          (e.from === "journal_entry" && e.to === "vendor_invoice")),
    );
    expect(direct).toBe(false);
  });

  it("gives every cluster a link to the reasoning core", () => {
    // The product's claim is one layer between the systems, not four
    // integrations. A cluster with no reasoning edge is a system the scene
    // silently leaves out.
    const byId = new Map(SCENE_NODES.map((n) => [n.id, n]));
    const reached = new Set(
      SCENE_EDGES.filter((e) => e.kind === "reasoning")
        .flatMap((e) => [e.from, e.to])
        .filter((id) => id !== CORE_ENDPOINT)
        .map((id) => byId.get(id)!.cluster),
    );
    expect([...reached].sort()).toEqual(["erp", "finance", "hr", "people"]);
  });

  it("touches the core on exactly one end of every reasoning edge", () => {
    for (const edge of SCENE_EDGES.filter((e) => e.kind === "reasoning")) {
      const ends = [edge.from, edge.to].filter((id) => id === CORE_ENDPOINT);
      expect(ends).toHaveLength(1);
    }
  });

  it("keeps the core out of the document trail", () => {
    for (const edge of SCENE_EDGES.filter((e) => e.kind === "chain")) {
      expect(edge.from).not.toBe(CORE_ENDPOINT);
      expect(edge.to).not.toBe(CORE_ENDPOINT);
    }
  });
});

describe("edgeRevealAtProgress", () => {
  it("draws nothing during scene 1", () => {
    // Scene 1's whole claim is that the work is unconnected. A visible edge
    // before the core ignites contradicts the copy under it.
    for (let i = 0; i < SCENE_EDGES.length; i += 1) {
      expect(edgeRevealAtProgress(0, i)).toBe(0);
      expect(edgeRevealAtProgress(0.27, i)).toBe(0);
    }
  });

  it("has every edge fully drawn by the end of scene 2", () => {
    for (let i = 0; i < SCENE_EDGES.length; i += 1) {
      expect(edgeRevealAtProgress(0.52, i), `edge ${i} unfinished`).toBeCloseTo(1);
      expect(edgeRevealAtProgress(1, i)).toBeCloseTo(1);
    }
  });

  it("never retracts an edge once drawn", () => {
    for (let i = 0; i < SCENE_EDGES.length; i += 1) {
      let previous = -1;
      for (let p = 0; p <= 1; p += 0.01) {
        const value = edgeRevealAtProgress(p, i);
        expect(value).toBeGreaterThanOrEqual(previous);
        previous = value;
      }
    }
  });

  it("resolves the paperwork trail before the core's own connections", () => {
    // Order carries the argument: these documents were always related, and
    // *then* here is the thing that noticed.
    const mid = 0.42;
    const chainDone = SCENE_EDGES.map((e, i) => ({ e, i }))
      .filter(({ e }) => e.kind === "chain")
      .map(({ i }) => edgeRevealAtProgress(mid, i));
    const reasoningDone = SCENE_EDGES.map((e, i) => ({ e, i }))
      .filter(({ e }) => e.kind === "reasoning")
      .map(({ i }) => edgeRevealAtProgress(mid, i));

    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(chainDone)).toBeGreaterThan(mean(reasoningDone));
  });

  it("staggers rather than switching every edge on at once", () => {
    // A diagram that appears on one frame reads as being switched on.
    const values = SCENE_EDGES.map((_, i) => edgeRevealAtProgress(0.36, i));
    const partial = values.filter((v) => v > 0.001 && v < 0.999);
    expect(partial.length).toBeGreaterThan(1);
  });

  it("clamps out-of-range input instead of throwing", () => {
    expect(edgeRevealAtProgress(Number.NaN, 0)).toBe(0);
    expect(() => edgeRevealAtProgress(0.5, -5)).not.toThrow();
    expect(() => edgeRevealAtProgress(0.5, 9999)).not.toThrow();
  });
});

describe("cardPositionAt", () => {
  it("sits at the scattered position when nothing has settled", () => {
    const node = SCENE_NODES[0];
    const at = cardPositionAt(node, 0, 0);
    // Drift is present at t=0, so compare loosely: the point is that the card
    // is at its scattered anchor and not at its cluster home.
    for (let axis = 0; axis < 3; axis += 1) {
      expect(Math.abs(at[axis] - node.scattered[axis])).toBeLessThan(1);
    }
  });

  it("arrives at its cluster home once fully settled", () => {
    const node = SCENE_NODES[0];
    const at = cardPositionAt(node, 1, 0);
    for (let axis = 0; axis < 3; axis += 1) {
      // Drift is damped to 15% at full settle, not to zero.
      expect(Math.abs(at[axis] - node.home[axis])).toBeLessThan(0.6);
    }
  });

  it("never wanders further than the layout budgeted for it", () => {
    // `DRIFT_MARGIN` reserves screen space for this excursion. If the
    // amplitudes in this function ever grow past it, cards start clipping the
    // frame edge and drifting onto the copy.
    for (const node of SCENE_NODES) {
      for (let t = 0; t < 40; t += 0.37) {
        const at = cardPositionAt(node, 0, t);
        const offset = Math.hypot(
          at[0] - node.scattered[0],
          at[1] - node.scattered[1],
          at[2] - node.scattered[2],
        );
        expect(offset).toBeLessThanOrEqual(0.8);
      }
    }
  });
});

describe("settled clusters", () => {
  it("seats every document in a cluster without overlapping its neighbours", () => {
    // A card is 4 world units wide. Five of them jittered inside a box this
    // size must overlap, and the settled graph read as four piles of paper.
    // Ring seating is what fixes that, so this is the assertion that keeps it.
    const byCluster = new Map<string, typeof SCENE_NODES>();
    for (const node of SCENE_NODES) {
      byCluster.set(node.cluster, [...(byCluster.get(node.cluster) ?? []), node] as never);
    }

    for (const [cluster, members] of byCluster) {
      for (let i = 0; i < members.length; i += 1) {
        for (let j = i + 1; j < members.length; j += 1) {
          const gap = Math.hypot(
            members[i].home[0] - members[j].home[0],
            members[i].home[1] - members[j].home[1],
          );
          expect(
            gap,
            `${members[i].id} and ${members[j].id} overlap in ${cluster}`,
            // A card is 4 wide and 5.25 tall, so anything under ~5 units of
            // separation still visibly overlaps its neighbour on the ring.
          ).toBeGreaterThan(CARD_WORLD_WIDTH * 1.25);
        }
      }
    }
  });

  it("keeps the four clusters clear of each other", () => {
    const centres = Object.values(CLUSTER_CENTERS);
    for (let i = 0; i < centres.length; i += 1) {
      for (let j = i + 1; j < centres.length; j += 1) {
        const gap = Math.hypot(centres[i][0] - centres[j][0], centres[i][1] - centres[j][1]);
        expect(gap).toBeGreaterThan(18);
      }
    }
  });

  it("balances the clusters around the core rather than to one side", () => {
    // An unbalanced arrangement put the whole settled graph right of centre
    // with an empty left half of frame.
    const centres = Object.values(CLUSTER_CENTERS);
    const mean = (axis: number) =>
      centres.reduce((sum, c) => sum + c[axis], 0) / centres.length;
    expect(Math.abs(mean(0))).toBeLessThan(3);
    expect(Math.abs(mean(1))).toBeLessThan(3);
  });

  it("leaves the core room to sit between them", () => {
    for (const node of SCENE_NODES) {
      expect(Math.hypot(node.home[0], node.home[1], node.home[2])).toBeGreaterThan(6);
    }
  });
});

describe("scene 3 — the run", () => {
  it("plays every beat of the run film across the scene", () => {
    // Scene 3 is `run-film.ts`'s beat list mapped onto scroll, not a second
    // script. Every beat must be reachable or the scene is telling a shorter
    // story than the one that is tested.
    const seen = new Set<number>();
    for (let p = SCENES[2].start; p <= SCENES[2].end; p += 0.001) {
      seen.add(runBeatIndexAtProgress(p));
    }
    expect(seen.size).toBe(FILM_BEATS.length);
  });

  it("runs the beats in order and never backwards", () => {
    let previous = -1;
    for (let p = 0; p <= 1; p += 0.002) {
      const index = runBeatIndexAtProgress(p);
      if (p >= SCENES[2].start && p <= SCENES[2].end) {
        expect(index).toBeGreaterThanOrEqual(previous);
        previous = index;
      }
    }
  });

  /**
   * The invariant the whole page exists to argue, asserted in 3D.
   *
   * `run-film.test.ts` already pins that `post_to_erp` is `pending` while
   * `approval_1` waits. This is the same fact carried into the scene: at the
   * hold, the ledger renders unwritten. If this ever flips, the scene is
   * showing the ERP being written to before a person approved.
   */
  it("has not written to the ERP while the run is held at the gate", () => {
    let heldSamples = 0;
    for (let p = SCENES[2].start; p <= SCENES[2].end; p += 0.001) {
      if (!heldAtGateAtProgress(p)) continue;
      heldSamples += 1;
      expect(erpWrittenAtProgress(p), `ERP written at the gate (p=${p.toFixed(3)})`).toBe(false);
    }
    // The hold must actually occur — a test that never enters the gate would
    // pass vacuously and prove nothing.
    expect(heldSamples).toBeGreaterThan(0);
  });

  it("shows the ledger unwritten before the gate and written after it", () => {
    const gate = FILM_BEATS.findIndex((b) => b.runStatus === "waiting_approval");
    const span = SCENES[2].end - SCENES[2].start;
    const at = (beat: number) =>
      SCENES[2].start + ((beat + 0.5) / FILM_BEATS.length) * span;

    expect(erpWrittenAtProgress(at(0))).toBe(false);
    expect(erpWrittenAtProgress(at(gate))).toBe(false);
    expect(erpWrittenAtProgress(at(FILM_BEATS.length - 1))).toBe(true);
  });

  it("holds the gate at the beat the film says it does", () => {
    const gate = FILM_BEATS.findIndex((b) => b.runStatus === "waiting_approval");
    const span = SCENES[2].end - SCENES[2].start;
    const mid = SCENES[2].start + ((gate + 0.5) / FILM_BEATS.length) * span;
    expect(heldAtGateAtProgress(mid)).toBe(true);
    expect(runBeatAtProgress(mid).nodeKey).toBe("approval_1");
  });

  it("focuses a real document on every beat", () => {
    // A beat with no focus is a camera pointed at empty room.
    const ids = new Set(SCENE_NODES.map((n) => n.id));
    const span = SCENES[2].end - SCENES[2].start;
    for (let beat = 0; beat < FILM_BEATS.length; beat += 1) {
      const p = SCENES[2].start + ((beat + 0.5) / FILM_BEATS.length) * span;
      const focus = focusedDocumentAtProgress(p);
      expect(focus, `beat ${FILM_BEATS[beat].id} has no focus`).not.toBeNull();
      expect(ids.has(focus!)).toBe(true);
    }
  });

  it("focuses nothing outside the run", () => {
    // The run scene lifts its focused document toward the camera and squares it
    // up. Applied at the opening — where the beat index clamps to 0 — that
    // stood the invoice upright inside the desk.
    for (const p of [0, 0.05, 0.2, 0.4, SCENES[2].start - 0.01, 0.9, 1]) {
      expect(focusedDocumentAtProgress(p), `focused at p=${p}`).toBeNull();
    }
  });

  it("points at the gate document while the gate holds", () => {
    const span = SCENES[2].end - SCENES[2].start;
    const gate = FILM_BEATS.findIndex((b) => b.runStatus === "waiting_approval");
    const p = SCENES[2].start + ((gate + 0.5) / FILM_BEATS.length) * span;
    expect(focusedDocumentAtProgress(p)).toBe("finance_approval");
  });

  it("keeps the camera on the finance cluster for the whole run", () => {
    // The run happens where INV-2291 settles. A camera that stays at the
    // origin through scene 3 is filming an empty part of the room.
    const finance = CLUSTER_CENTERS.finance;
    for (let p = 0.58; p <= 0.78; p += 0.01) {
      const { target } = cameraAtProgress(p);
      const distance = Math.hypot(
        target[0] - finance[0],
        target[1] - finance[1],
        target[2] - finance[2],
      );
      expect(distance).toBeLessThan(12);
    }
  });

  it("clamps out-of-range scrub instead of throwing", () => {
    expect(() => runBeatAtProgress(Number.NaN)).not.toThrow();
    expect(runBeatIndexAtProgress(-1)).toBe(0);
    expect(runBeatIndexAtProgress(2)).toBe(FILM_BEATS.length - 1);
  });
});

describe("documentPresenceAtProgress", () => {
  it("keeps the whole room present outside the run scene and the collapse", () => {
    for (const p of [0, 0.2, 0.4, 0.5, 0.9]) {
      for (const node of SCENE_NODES) {
        expect(documentPresenceAtProgress(node.id, p)).toBeCloseTo(1, 5);
      }
    }
  });

  it("recedes everything except the run's own documents during scene 3", () => {
    const mid = (SCENES[2].start + SCENES[2].end) / 2;
    for (const node of SCENE_NODES) {
      const presence = documentPresenceAtProgress(node.id, mid);
      if (RUN_CHAIN.includes(node.id)) {
        expect(presence, `${node.id} should stay present`).toBe(1);
      } else {
        expect(presence, `${node.id} should recede`).toBeLessThan(0.3);
      }
    }
  });

  it("keeps every document in the run chain a real document in the scene", () => {
    const ids = new Set(SCENE_NODES.map((n) => n.id));
    for (const id of RUN_CHAIN) expect(ids.has(id), `no document "${id}"`).toBe(true);
  });

  it("eases at the scene edges rather than switching off", () => {
    // A hard cut here reads as a layer being toggled. Sample just inside the
    // scene and confirm the value is on its way down, not already at the floor.
    const justInside = SCENES[2].start + 0.015;
    const other = SCENE_NODES.find((n) => !RUN_CHAIN.includes(n.id))!;
    const presence = documentPresenceAtProgress(other.id, justInside);
    expect(presence).toBeLessThan(1);
    expect(presence).toBeGreaterThan(0.3);
  });

  it("restores the room by the time scene 4 begins", () => {
    const other = SCENE_NODES.find((n) => !RUN_CHAIN.includes(n.id))!;
    expect(documentPresenceAtProgress(other.id, SCENES[3].start)).toBeCloseTo(1, 5);
  });

  it("is never zero during the run — that happens inside a company, not an empty room", () => {
    // Bounded to the run scene on purpose. The *ending* does empty the room,
    // which is the collapse into the mark and is asserted separately.
    for (let p = SCENES[2].start; p <= SCENES[2].end; p += 0.005) {
      for (const node of SCENE_NODES) {
        expect(documentPresenceAtProgress(node.id, p)).toBeGreaterThan(0.1);
      }
    }
  });
});

describe("scene 4 — clusters and the mark", () => {
  it("names every cluster", () => {
    for (const cluster of Object.keys(CLUSTER_CENTERS) as (keyof typeof CLUSTER_CENTERS)[]) {
      expect(CLUSTER_LABELS[cluster]?.length).toBeGreaterThan(0);
    }
  });

  it("shows the cluster names only during the pull-back", () => {
    expect(clusterLabelOpacityAtProgress(0)).toBe(0);
    expect(clusterLabelOpacityAtProgress(0.5)).toBe(0);
    expect(clusterLabelOpacityAtProgress(0.8)).toBe(0);
    expect(clusterLabelOpacityAtProgress(0.88)).toBeGreaterThan(0.8);
    // Gone before the collapse, so they never compete with the mark.
    expect(clusterLabelOpacityAtProgress(1)).toBe(0);
  });

  it("collapses only at the very end", () => {
    expect(markCollapseAtProgress(0)).toBe(0);
    expect(markCollapseAtProgress(0.8)).toBe(0);
    expect(markCollapseAtProgress(0.92)).toBe(0);
    expect(markCollapseAtProgress(1)).toBeCloseTo(1);
  });

  it("never runs the collapse backwards", () => {
    let previous = -1;
    for (let p = 0; p <= 1; p += 0.005) {
      const value = markCollapseAtProgress(p);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  /**
   * The mark's middle node is held open because it is the approval gate. If
   * the approvals ever collapsed into a filled node instead, the ending would
   * be drawing a different claim from the one the page spent four scenes on.
   */
  it("collapses the approval gates into the open middle node", () => {
    const open = MARK_NODES.find((n) => n.open)!;
    const approvals = SCENE_NODES.filter((n) => n.kind === "approval");
    expect(approvals.length).toBeGreaterThan(0);
    for (const node of approvals) {
      expect(markTargetFor(node)).toEqual(open.position);
    }
  });

  it("collapses everything else into a filled node", () => {
    const filled = MARK_NODES.filter((n) => !n.open).map((n) => n.position);
    for (const node of SCENE_NODES.filter((n) => n.kind !== "approval")) {
      expect(filled).toContainEqual(markTargetFor(node));
    }
  });

  it("draws the same three-node mark as the SVG in the nav", () => {
    // Two filled nodes and exactly one open ring, matching
    // components/marketing/orkest-mark.tsx. Three unrelated drawings of one
    // mark is the failure this guards.
    expect(MARK_NODES).toHaveLength(3);
    expect(MARK_NODES.filter((n) => n.open)).toHaveLength(1);
    expect(MARK_NODES[1].open).toBe(true);
    // The open node is the largest, as it is in the SVG (r=3.25 vs r=2.25).
    expect(MARK_NODES[1].radius).toBeGreaterThan(MARK_NODES[0].radius);
    // And it sits between the other two, on the diagonal.
    expect(MARK_NODES[0].position[0]).toBeLessThan(MARK_NODES[1].position[0]);
    expect(MARK_NODES[1].position[0]).toBeLessThan(MARK_NODES[2].position[0]);
    expect(MARK_NODES[0].position[1]).toBeGreaterThan(MARK_NODES[1].position[1]);
    expect(MARK_NODES[1].position[1]).toBeGreaterThan(MARK_NODES[2].position[1]);
  });

  it("clears the room so the mark is the last frame", () => {
    for (const node of SCENE_NODES) {
      expect(documentPresenceAtProgress(node.id, 1)).toBeCloseTo(0, 3);
    }
  });

  it("absorbs the core into the mark without claiming it shut down", () => {
    // The ignition curve still never dims — the core does not stop reasoning,
    // it is absorbed. Only the on-screen visibility goes.
    expect(coreIntensityAtProgress(1)).toBeCloseTo(1);
    expect(coreVisibilityAtProgress(1)).toBeCloseTo(0);
    expect(coreVisibilityAtProgress(0.85)).toBeCloseTo(1);
  });
});

describe("the desk opening", () => {
  it("rests every document ON the desk, not inside it", () => {
    // Laying a card at exactly DESK_Y centres its 0.06 depth in the desk's top
    // face, so half of it is below the surface and the two coplanar faces
    // fight — a document ends up looking sliced off inside the table.
    for (const node of SCENE_NODES) {
      expect(node.desk[1]).toBeCloseTo(CARD_REST_Y, 5);
      expect(node.desk[1]).toBeGreaterThan(DESK_Y);
    }
  });

  it("starts on the desk and is fully airborne by liftoff", () => {
    expect(deskLiftAtProgress(0)).toBe(0);
    expect(deskLiftAtProgress(LIFTOFF_END)).toBeCloseTo(1);
    expect(deskLiftAtProgress(1)).toBeCloseTo(1);
  });

  it("never lowers a document back toward the desk", () => {
    let previous = -1;
    for (let p = 0; p <= 1; p += 0.005) {
      const value = deskLiftAtProgress(p);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it("puts documents exactly on the desk at progress 0", () => {
    // Not merely near it: at rest, before any lift, a document lies on the
    // surface with no drift at all. Paper on a table does not bob.
    for (const node of SCENE_NODES) {
      const at = cardPositionAt(node, 0, 3.7, 0);
      expect(at[0]).toBeCloseTo(node.desk[0], 5);
      expect(at[1]).toBeCloseTo(node.desk[1], 5);
      expect(at[2]).toBeCloseTo(node.desk[2], 5);
    }
  });

  it("lies documents flat at rest and turns them upright once airborne", () => {
    const node = SCENE_NODES[0];
    expect(cardRotationAt(node, 0, 0)[0]).toBeCloseTo(-Math.PI / 2, 5);
    // Airborne, the tilt is the small oscillation and nothing like a right angle.
    expect(Math.abs(cardRotationAt(node, 0, LIFTOFF_END)[0])).toBeLessThan(0.2);
  });

  it("clears the desk surface away before the field settles", () => {
    expect(deskPresenceAtProgress(0)).toBeCloseTo(1);
    expect(deskPresenceAtProgress(LIFTOFF_END)).toBeCloseTo(0);
    // Gone well before scene 2, or a large pale plane hangs in the lower frame
    // looking like a rendering artefact.
    expect(deskPresenceAtProgress(SCENES[1].start)).toBeCloseTo(0);
  });

  it("shows a deskful of documents, not a token few", () => {
    // The first version spaced the desk with the upright footprint and seated
    // exactly two documents on the whole surface.
    const onScreen = SCENE_NODES.filter(
      (node) => framing(inflateDeskFootprint(node)) === "inside",
    );
    expect(onScreen.length).toBeGreaterThanOrEqual(8);
  });

  it("keeps the desk clear of the HERO copy and never slices a document", () => {
    // The desk is the page's hero now, so the reserved band is the headline's
    // (upper frame), not the scene caption's (lower frame).
    for (const node of SCENE_NODES) {
      const screen = inflateDeskFootprint(node);
      expect(framing(screen), `${node.id} straddles the frame edge on the desk`).not.toBe(
        "straddling",
      );
      if (framing(screen) === "inside") {
        expect(intersectsHeroZone(screen), `${node.id} lands on the headline`).toBe(false);
      }
    }
  });

  it("keeps the documents in the lower frame, under the headline", () => {
    // The composition the opening depends on: wall and headline above, desk and
    // paperwork below. A document drifting up into the headline breaks both.
    for (const node of SCENE_NODES) {
      const screen = inflateDeskFootprint(node);
      if (framing(screen) !== "inside") continue;
      expect(screen.y + screen.radiusY, `${node.id} rises into the headline`).toBeLessThanOrEqual(
        HERO_SAFE_ZONE.minY,
      );
    }
  });

  it("leaves a clear channel for the calls to action", () => {
    // Documents may come up either side of the buttons but never behind them.
    for (const node of SCENE_NODES) {
      const screen = inflateDeskFootprint(node);
      if (framing(screen) !== "inside") continue;
      const radiusX = screen.radiusY / 1.78;
      const overlapsChannel =
        screen.x + radiusX > HERO_CTA_CHANNEL.minX &&
        screen.x - radiusX < HERO_CTA_CHANNEL.maxX &&
        screen.y + screen.radiusY > HERO_CTA_CHANNEL.minY &&
        screen.y - screen.radiusY < HERO_CTA_CHANNEL.maxY;
      expect(overlapsChannel, `${node.id} sits behind the buttons`).toBe(false);
    }
  });

  it("hands over from the hero copy to the scene caption without overlap", () => {
    // Two competing blocks of copy on one screen is one too many. The hero
    // must be gone by the time the caption is legible.
    expect(heroOpacityAtProgress(0)).toBe(1);
    expect(sceneCaptionOpacityAtProgress(0)).toBe(0);
    expect(sceneCaptionOpacityAtProgress(LIFTOFF_END)).toBeCloseTo(1);
    expect(heroOpacityAtProgress(LIFTOFF_END)).toBe(0);

    for (let p = 0; p <= 0.3; p += 0.002) {
      const both = heroOpacityAtProgress(p) > 0.05 && sceneCaptionOpacityAtProgress(p) > 0.05;
      expect(both, `hero and caption both legible at p=${p.toFixed(3)}`).toBe(false);
    }
  });

  it("keeps the desk out from under the floating nav", () => {
    // The nav pill is drawn over the canvas; readable paper beneath it is lost.
    for (const node of SCENE_NODES) {
      const screen = inflateDeskFootprint(node);
      if (framing(screen) !== "inside") continue;
      expect(screen.y + screen.radiusY, `${node.id} runs under the nav`).toBeLessThan(0.78);
    }
  });
});

describe("the desk dissolve", () => {
  it("stays fully solid through the first half of the liftoff", () => {
    // A long slow alpha fade on a solid wooden desk spends most of the
    // transition showing a half-transparent object, which never looks like
    // anything real. It holds, then goes quickly.
    expect(deskPresenceAtProgress(0)).toBe(1);
    expect(deskPresenceAtProgress(LIFTOFF_END * 0.4)).toBe(1);
    expect(deskPresenceAtProgress(LIFTOFF_END * 0.55)).toBe(1);
    expect(deskPresenceAtProgress(LIFTOFF_END * 0.8)).toBeLessThan(1);
    expect(deskPresenceAtProgress(LIFTOFF_END)).toBeCloseTo(0);
  });

  it("never brings the desk back", () => {
    let previous = 2;
    for (let p = 0; p <= 1; p += 0.005) {
      const value = deskPresenceAtProgress(p);
      expect(value).toBeLessThanOrEqual(previous);
      previous = value;
    }
  });
});
