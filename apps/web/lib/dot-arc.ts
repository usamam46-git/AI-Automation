/**
 * Geometry for the dot-matrix arc — the reference's signature data mark
 * (`public/Sample2.webp`): a ring drawn as a run of discrete dots, of which a
 * leading fraction is "filled" and the rest sit as a faint track.
 *
 * Pure and separate from the component for the same reason `lib/scene-script.ts`
 * is separate from the scene: the arc's placement is arithmetic, and arithmetic
 * that is eyeballed in a browser gets silently wrong. `dot-arc.test.ts` pins the
 * endpoints, the ordering and the fill boundary.
 *
 * Coordinates are SVG user units in a box of `size × size`, y growing DOWNWARD
 * (SVG convention), so an angle of -90° is the top of the ring.
 */

export type ArcDot = {
  cx: number;
  cy: number;
  /** Whether this dot is inside the filled leading run. */
  filled: boolean;
  /**
   * Position along the arc, 0 at the start and 1 at the last dot. Lets a caller
   * taper size or opacity along the run without recomputing angles.
   */
  t: number;
};

export type DotArcOptions = {
  /** Width and height of the square viewBox. */
  size: number;
  /** Dot count. */
  count: number;
  /** Fraction of the arc that reads as filled, clamped to 0..1. */
  value: number;
  /** Sweep in degrees. 270 leaves a quarter open, like the reference. */
  sweep?: number;
  /** Where the sweep begins, in degrees, with -90 at the top. */
  startAngle?: number;
  /** Ring radius as a fraction of half the box. Leaves room for the dot itself. */
  radiusRatio?: number;
};

const DEFAULTS = {
  sweep: 270,
  startAngle: 135,
  radiusRatio: 0.82,
} as const;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Lay out the dots.
 *
 * `count` below 2 returns a single dot at the start angle rather than dividing
 * by zero — a one-dot arc is meaningless but it must not throw, because `count`
 * can reach here from a caller sizing dots to available width.
 */
export function dotArc(options: DotArcOptions): ArcDot[] {
  const { size, count } = options;
  const sweep = options.sweep ?? DEFAULTS.sweep;
  const startAngle = options.startAngle ?? DEFAULTS.startAngle;
  const radiusRatio = options.radiusRatio ?? DEFAULTS.radiusRatio;

  if (count <= 0) return [];

  const value = clamp01(options.value);
  const centre = size / 2;
  const radius = centre * radiusRatio;

  // The number of dots that read as filled. Rounding (not flooring) keeps the
  // mark honest at both ends: a value of 0 must show no filled dot and a value
  // of 1 must fill every one, which `Math.round(value * count)` gives exactly.
  const filledCount = Math.round(value * count);

  const dots: ArcDot[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = count === 1 ? 0 : i / (count - 1);
    const degrees = startAngle + t * sweep;
    const radians = (degrees * Math.PI) / 180;
    dots.push({
      cx: centre + radius * Math.cos(radians),
      cy: centre + radius * Math.sin(radians),
      filled: i < filledCount,
      t,
    });
  }
  return dots;
}

/**
 * How many dots the caller asked to be filled. Exported so a legend or a label
 * can state the same number the mark draws, instead of recomputing the rounding
 * rule and disagreeing with it by one.
 */
export function filledDotCount(count: number, value: number): number {
  if (count <= 0) return 0;
  return Math.round(clamp01(value) * count);
}
