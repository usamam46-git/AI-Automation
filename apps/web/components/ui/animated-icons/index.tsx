"use client";

import * as React from "react";
import { motion, useAnimation, useReducedMotion, type Variants } from "motion/react";

import { cn } from "@/lib/utils";

/**
 * Hover-animated nav icons.
 *
 * ## Why these are hand-built rather than a dependency
 *
 * `motion` v13 is already in the tree (see `components/ui/ai-text-loading.tsx`)
 * and these are ordinary Lucide paths, so an animated-icon package would add a
 * bundle and a second icon language for something the repo can already express.
 * This is the same copy-in approach every other `components/ui/*` file here
 * uses — the pqoqubbw/icons pattern, not the pqoqubbw/icons dependency.
 *
 * ## Three rules, and they are the difference between polish and noise
 *
 * 1. **Nothing moves unprompted.** Every animation is driven by the parent's
 *    hover/focus, via `controls`. An icon that loops on its own turns a sidebar
 *    into a distraction and reads as decoration for its own sake.
 * 2. **`prefers-reduced-motion` wins.** When set, the controls are never
 *    driven and the icon renders as a plain static glyph. This is vestibular
 *    accessibility, not a nicety.
 * 3. **The motion has to mean something.** Each variant animates the part of
 *    the glyph that carries its meaning — the pulse traces along the activity
 *    line, the wrench turns, the book's pages lift. Motion applied uniformly
 *    (every icon "bounces") is the animated equivalent of a rocket emoji.
 *
 * Stroke geometry is copied from Lucide so these sit on the same 24×24 grid at
 * the same 2px stroke as every other icon in the product; they must be
 * indistinguishable at rest.
 */

export type AnimatedIconProps = {
  className?: string;
  /** Driven by the parent so the whole nav row is one hover target. */
  active?: boolean;
};

const SVG_PROPS = {
  xmlns: "http://www.w3.org/2000/svg",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** Shared plumbing: run `variants.animate` while `active`, `normal` otherwise. */
function useHoverControls(active: boolean | undefined) {
  const controls = useAnimation();
  const reduced = useReducedMotion();

  React.useEffect(() => {
    if (reduced) return;
    controls.start(active ? "animate" : "normal");
  }, [active, controls, reduced]);

  return { controls, reduced };
}

/* -------------------------------------------------------------------------- */

/** Dashboard — the four panes settle into place. */
export function DashboardIcon({ className, active }: AnimatedIconProps) {
  const { controls, reduced } = useHoverControls(active);
  const pane: Variants = {
    normal: { scale: 1, opacity: 1 },
    animate: (i: number) => ({
      scale: [1, 0.82, 1],
      opacity: [1, 0.65, 1],
      transition: { duration: 0.42, delay: i * 0.06, ease: "easeInOut" },
    }),
  };
  return (
    <svg {...SVG_PROPS} className={cn("size-4", className)} aria-hidden>
      {[
        { d: "M3 3h7v9H3z", i: 0 },
        { d: "M14 3h7v5h-7z", i: 1 },
        { d: "M14 12h7v9h-7z", i: 2 },
        { d: "M3 16h7v5H3z", i: 3 },
      ].map(({ d, i }) => (
        <motion.path key={d} d={d} variants={reduced ? undefined : pane} custom={i} animate={controls} initial="normal" />
      ))}
    </svg>
  );
}

/** Workflows — the graph's connectors draw themselves. */
export function WorkflowIcon({ className, active }: AnimatedIconProps) {
  const { controls, reduced } = useHoverControls(active);
  const link: Variants = {
    normal: { pathLength: 1, opacity: 1 },
    animate: { pathLength: [0, 1], opacity: [0.3, 1], transition: { duration: 0.45, ease: "easeInOut" } },
  };
  return (
    <svg {...SVG_PROPS} className={cn("size-4", className)} aria-hidden>
      <rect width="8" height="8" x="3" y="3" rx="2" />
      <rect width="8" height="8" x="13" y="13" rx="2" />
      <motion.path d="M7 11v4a2 2 0 0 0 2 2h4" variants={reduced ? undefined : link} animate={controls} initial="normal" />
    </svg>
  );
}

/** Executions — the pulse travels along the trace. */
export function ActivityIcon({ className, active }: AnimatedIconProps) {
  const { controls, reduced } = useHoverControls(active);
  const trace: Variants = {
    normal: { pathLength: 1, pathOffset: 0 },
    animate: { pathLength: [0.25, 0.25], pathOffset: [0, 1], transition: { duration: 0.8, ease: "linear" } },
  };
  return (
    <svg {...SVG_PROPS} className={cn("size-4", className)} aria-hidden>
      <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" opacity={0.35} />
      <motion.path
        d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"
        variants={reduced ? undefined : trace}
        animate={controls}
        initial="normal"
      />
    </svg>
  );
}

/** Tools — the wrench turns, as a wrench does. */
export function ToolsIcon({ className, active }: AnimatedIconProps) {
  const { controls, reduced } = useHoverControls(active);
  const turn: Variants = {
    normal: { rotate: 0 },
    animate: { rotate: [0, -22, 10, 0], transition: { duration: 0.55, ease: "easeInOut" } },
  };
  return (
    <svg {...SVG_PROPS} className={cn("size-4", className)} aria-hidden>
      <motion.path
        d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
        variants={reduced ? undefined : turn}
        animate={controls}
        initial="normal"
        style={{ originX: "50%", originY: "50%" }}
      />
    </svg>
  );
}

/** Knowledge — the cover opens. */
export function KnowledgeIcon({ className, active }: AnimatedIconProps) {
  const { controls, reduced } = useHoverControls(active);
  const cover: Variants = {
    normal: { scaleX: 1, x: 0 },
    animate: { scaleX: [1, 0.86, 1], x: [0, 1.4, 0], transition: { duration: 0.5, ease: "easeInOut" } },
  };
  return (
    <svg {...SVG_PROPS} className={cn("size-4", className)} aria-hidden>
      <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20" />
      <motion.g variants={reduced ? undefined : cover} animate={controls} initial="normal" style={{ originX: "25%", originY: "50%" }}>
        <path d="M8 7h8" />
        <path d="M8 11h5" />
      </motion.g>
    </svg>
  );
}

/** Workspaces — the tiles fan out. */
export function WorkspacesIcon({ className, active }: AnimatedIconProps) {
  const { controls, reduced } = useHoverControls(active);
  const tile: Variants = {
    normal: { x: 0, y: 0 },
    animate: (i: number) => ({
      x: [0, i === 1 || i === 3 ? 1.4 : -1.4, 0],
      y: [0, i > 1 ? 1.4 : -1.4, 0],
      transition: { duration: 0.45, ease: "easeInOut" },
    }),
  };
  return (
    <svg {...SVG_PROPS} className={cn("size-4", className)} aria-hidden>
      {[
        { d: "M3 3h7v7H3z", i: 0 },
        { d: "M14 3h7v7h-7z", i: 1 },
        { d: "M3 14h7v7H3z", i: 2 },
        { d: "M14 14h7v7h-7z", i: 3 },
      ].map(({ d, i }) => (
        <motion.path key={d} d={d} variants={reduced ? undefined : tile} custom={i} animate={controls} initial="normal" />
      ))}
    </svg>
  );
}

/** Audit log — the scroll unrolls. */
export function AuditIcon({ className, active }: AnimatedIconProps) {
  const { controls, reduced } = useHoverControls(active);
  const lines: Variants = {
    normal: { pathLength: 1, opacity: 1 },
    animate: (i: number) => ({
      pathLength: [0, 1],
      opacity: [0.2, 1],
      transition: { duration: 0.32, delay: i * 0.08, ease: "easeOut" },
    }),
  };
  return (
    <svg {...SVG_PROPS} className={cn("size-4", className)} aria-hidden>
      <path d="M15 12h-5" />
      <path d="M15 8h-5" />
      <path d="M19 17V5a2 2 0 0 0-2-2H4" />
      <path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3" />
      {[
        { d: "M15 12h-5", i: 0 },
        { d: "M15 8h-5", i: 1 },
      ].map(({ d, i }) => (
        <motion.path key={d} d={d} variants={reduced ? undefined : lines} custom={i} animate={controls} initial="normal" />
      ))}
    </svg>
  );
}

/** Settings — the cog turns a notch. */
export function SettingsIcon({ className, active }: AnimatedIconProps) {
  const { controls, reduced } = useHoverControls(active);
  const cog: Variants = {
    normal: { rotate: 0 },
    animate: { rotate: 60, transition: { duration: 0.6, ease: "easeInOut" } },
  };
  return (
    <svg {...SVG_PROPS} className={cn("size-4", className)} aria-hidden>
      <motion.g variants={reduced ? undefined : cog} animate={controls} initial="normal" style={{ originX: "50%", originY: "50%" }}>
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      </motion.g>
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/**
 * Agents — the head sits still and the two eyes blink.
 *
 * Deliberately the smallest motion in the set. The Agents surface is a preview
 * of unbuilt work, so an icon that swung or spun would advertise it as the
 * liveliest thing in the sidebar, which is the opposite of true. A blink reads
 * as "there is something here" without competing with the rows that do work.
 */
export function AgentsIcon({ className, active }: AnimatedIconProps) {
  const { controls, reduced } = useHoverControls(active);
  const blink: Variants = {
    normal: { scaleY: 1 },
    animate: { scaleY: [1, 0.1, 1], transition: { duration: 0.4, ease: "easeInOut" } },
  };
  return (
    <svg {...SVG_PROPS} className={cn("size-4", className)} aria-hidden>
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <motion.g variants={reduced ? undefined : blink} animate={controls} initial="normal" style={{ originX: "50%", originY: "50%" }}>
        <path d="M15 13v2" />
        <path d="M9 13v2" />
      </motion.g>
    </svg>
  );
}
