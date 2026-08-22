import * as React from "react";
import { dotArc } from "@/lib/dot-arc";
import { cn } from "@/lib/utils";

/**
 * The reference's dot-matrix arc (`public/Sample2.webp`), as a data mark.
 *
 * All geometry lives in the pure `lib/dot-arc.ts`; this is only the SVG shell.
 * Dots taper slightly along the run — the mark reads as a value accelerating
 * around the ring rather than as a dashed circle.
 *
 * `value` is a 0..1 fraction and is clamped inside `dotArc`, so a caller may
 * pass a raw ratio without pre-checking it. A `null` value renders the empty
 * track, which is the right picture for "nothing has finished yet" — the same
 * distinction `formatSuccessRate` draws between null and 0.
 */
export function DotArc({
  value,
  size = 88,
  count = 26,
  className,
  label,
}: {
  value: number | null | undefined;
  size?: number;
  count?: number;
  className?: string;
  /** Accessible description. Without it the mark is decorative and hidden. */
  label?: string;
}) {
  const dots = React.useMemo(() => dotArc({ size: 100, count, value: value ?? 0 }), [count, value]);

  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={cn("overflow-visible", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {dots.map((dot, index) => (
        <circle
          key={index}
          cx={dot.cx}
          cy={dot.cy}
          // 2.4 -> 4.0 along the run. Kept subtle: a stronger taper starts to
          // read as a comet and pulls the eye off the figure in the middle.
          r={2.4 + dot.t * 1.6}
          className={dot.filled ? "fill-lime-deep dark:fill-lime" : "fill-foreground/12"}
        />
      ))}
    </svg>
  );
}
