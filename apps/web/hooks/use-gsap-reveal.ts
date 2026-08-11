"use client";

import * as React from "react";

import { gsap, runWhenVisible } from "@/lib/gsap";
import { usePrefersReducedMotion } from "@/hooks/use-media-query";

/**
 * Runs a GSAP setup function scoped to `rootRef`, guarded three ways.
 *
 * Every scroll reveal on this page is a `gsap.from(..., { opacity: 0 })`, which
 * blanks its targets the instant the tween is built and relies on the ticker to
 * bring them back. That makes the content's visibility dependent on animation
 * completing — a bad trade for a marketing page, where the failure mode is an
 * invisible section rather than a missing flourish. The guards:
 *
 *   - **Reduced motion** skips setup entirely, so the content simply renders.
 *   - **`runWhenVisible`** defers setup until the document is visible.
 *     `requestAnimationFrame` does not run in a background tab, so a page
 *     opened in one would otherwise build every tween, blank every section,
 *     and freeze there.
 *   - **`clearProps` on completion** (the caller's job) strips the inline
 *     styles afterwards, so a finished section is styled only by its classes.
 *
 * The setup function is held in a ref, so callers can pass an inline closure
 * without memoising it and without re-running the effect on every render.
 */
export function useGsapReveal(
  rootRef: React.RefObject<HTMLElement | null>,
  setup: () => void,
): void {
  const reducedMotion = usePrefersReducedMotion();
  const setupRef = React.useRef(setup);

  // Kept current so the effect always calls the latest closure, while the
  // effect itself stays keyed only on `reducedMotion`.
  React.useEffect(() => {
    setupRef.current = setup;
  });

  React.useEffect(() => {
    if (reducedMotion) return;
    const root = rootRef.current;
    if (!root) return;

    let ctx: gsap.Context | undefined;
    const dispose = runWhenVisible(() => {
      ctx = gsap.context(() => setupRef.current(), root);
    });

    return () => {
      dispose();
      ctx?.revert();
    };
  }, [reducedMotion, rootRef]);
}
