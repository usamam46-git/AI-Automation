import { describe, expect, it } from "vitest";
import { dotArc, filledDotCount } from "@/lib/dot-arc";

const SIZE = 100;

describe("dotArc", () => {
  it("returns exactly `count` dots", () => {
    expect(dotArc({ size: SIZE, count: 24, value: 0.5 })).toHaveLength(24);
  });

  it("returns nothing for a non-positive count rather than throwing", () => {
    expect(dotArc({ size: SIZE, count: 0, value: 0.5 })).toEqual([]);
    expect(dotArc({ size: SIZE, count: -3, value: 0.5 })).toEqual([]);
  });

  it("places a single dot at the start angle instead of dividing by zero", () => {
    const [only] = dotArc({ size: SIZE, count: 1, value: 1 });
    expect(only.t).toBe(0);
    expect(Number.isFinite(only.cx)).toBe(true);
    expect(Number.isFinite(only.cy)).toBe(true);
  });

  it("runs t from 0 to 1 across the arc", () => {
    const dots = dotArc({ size: SIZE, count: 10, value: 0 });
    expect(dots[0].t).toBe(0);
    expect(dots[dots.length - 1].t).toBe(1);
  });

  it("keeps every dot inside the box", () => {
    for (const dot of dotArc({ size: SIZE, count: 40, value: 0.5 })) {
      expect(dot.cx).toBeGreaterThanOrEqual(0);
      expect(dot.cx).toBeLessThanOrEqual(SIZE);
      expect(dot.cy).toBeGreaterThanOrEqual(0);
      expect(dot.cy).toBeLessThanOrEqual(SIZE);
    }
  });

  it("sits every dot on the ring, at the requested radius", () => {
    const dots = dotArc({ size: SIZE, count: 24, value: 0.5, radiusRatio: 0.8 });
    for (const dot of dots) {
      const r = Math.hypot(dot.cx - SIZE / 2, dot.cy - SIZE / 2);
      expect(r).toBeCloseTo(SIZE / 2 * 0.8, 6);
    }
  });

  it("leaves the default 270deg sweep open at the bottom", () => {
    // Start 135deg, sweep 270 -> ends at 405 (=45). Both endpoints are below
    // centre in SVG coordinates, and the gap between them is the open quarter.
    const dots = dotArc({ size: SIZE, count: 24, value: 0 });
    expect(dots[0].cy).toBeGreaterThan(SIZE / 2);
    expect(dots[dots.length - 1].cy).toBeGreaterThan(SIZE / 2);
    expect(dots[0].cx).toBeLessThan(SIZE / 2);
    expect(dots[dots.length - 1].cx).toBeGreaterThan(SIZE / 2);
  });

  it("fills a leading run, never a scattered set", () => {
    const dots = dotArc({ size: SIZE, count: 20, value: 0.5 });
    const firstUnfilled = dots.findIndex((d) => !d.filled);
    expect(firstUnfilled).toBeGreaterThan(0);
    expect(dots.slice(firstUnfilled).every((d) => !d.filled)).toBe(true);
  });

  it("fills nothing at 0 and everything at 1", () => {
    expect(dotArc({ size: SIZE, count: 20, value: 0 }).some((d) => d.filled)).toBe(false);
    expect(dotArc({ size: SIZE, count: 20, value: 1 }).every((d) => d.filled)).toBe(true);
  });

  it("clamps a value outside 0..1 instead of overflowing the run", () => {
    expect(dotArc({ size: SIZE, count: 20, value: 4 }).every((d) => d.filled)).toBe(true);
    expect(dotArc({ size: SIZE, count: 20, value: -2 }).some((d) => d.filled)).toBe(false);
  });

  it("treats a non-finite value as empty rather than producing NaN dots", () => {
    const dots = dotArc({ size: SIZE, count: 20, value: Number.NaN });
    expect(dots.some((d) => d.filled)).toBe(false);
    expect(dots.every((d) => Number.isFinite(d.cx) && Number.isFinite(d.cy))).toBe(true);
  });
});

describe("filledDotCount", () => {
  it("agrees with what dotArc actually fills", () => {
    for (const value of [0, 0.13, 0.5, 0.77, 1]) {
      const dots = dotArc({ size: SIZE, count: 24, value });
      expect(filledDotCount(24, value)).toBe(dots.filter((d) => d.filled).length);
    }
  });

  it("is 0 for a non-positive count", () => {
    expect(filledDotCount(0, 0.9)).toBe(0);
  });
});
