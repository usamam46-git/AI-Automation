import { describe, expect, it } from "vitest";

import { smoothScrollOptions } from "@/lib/smooth-scroll";

describe("smoothScrollOptions", () => {
  it("never lets Lenis run its own raf loop", () => {
    // GSAP's ticker calls lenis.raf(). A second loop advances the animation
    // twice per frame and desynchronises it from ScrollTrigger.update, which is
    // driven by that same ticker. ReactLenis defaults autoRaf to true, so this
    // must be set explicitly on both paths.
    expect(smoothScrollOptions(false).autoRaf).toBe(false);
    expect(smoothScrollOptions(true).autoRaf).toBe(false);
  });

  it("leaves touch scrolling to the browser on both paths", () => {
    // syncTouch fights iOS's native inertia and the scene has never been
    // verified on a real device. Flipping this is a mobile change, not a
    // tuning change.
    expect(smoothScrollOptions(false).syncTouch).toBe(false);
    expect(smoothScrollOptions(true).syncTouch).toBe(false);
  });

  it("smooths the wheel only when motion is not reduced", () => {
    expect(smoothScrollOptions(false).smoothWheel).toBe(true);
    expect(smoothScrollOptions(true).smoothWheel).toBe(false);
  });

  it("animates anchor jumps normally and cuts them under reduced motion", () => {
    expect(smoothScrollOptions(false).anchors).toBe(true);
    expect(smoothScrollOptions(true).anchors).toEqual({ immediate: true });
  });

  it("keeps the scrub's feel knob where the landing page was tuned", () => {
    // Not a magic number worth pinning for its own sake — it is pinned so that
    // changing the page's feel is a deliberate edit with a test to update,
    // rather than something that drifts in alongside an unrelated change.
    expect(smoothScrollOptions(false).lerp).toBe(0.1);
    expect(smoothScrollOptions(false).wheelMultiplier).toBe(1);
  });
});
