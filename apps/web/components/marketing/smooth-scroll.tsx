"use client";

import * as React from "react";
import { ReactLenis, useLenis } from "lenis/react";

import { gsap, ScrollTrigger } from "@/lib/gsap";
import { usePrefersReducedMotion } from "@/hooks/use-media-query";
import { smoothScrollOptions } from "@/lib/smooth-scroll";

/**
 * Hands `lenis.raf` to GSAP's ticker.
 *
 * ## Why this is a child component and not an effect in `SmoothScroll`
 *
 * It was written as a `ref` on `<ReactLenis>` first, and that shipped a page
 * whose **mouse wheel did nothing at all** while the scrollbar and the arrow
 * keys still worked. `ReactLenis` holds its instance in `useState` and creates
 * it in its own effect (`setLenis(new Lenis(...))`), exposing it through
 * `useImperativeHandle(..., [lenis])`. So on the first commit the ref's `lenis`
 * is `undefined`, and the `setLenis` that follows re-renders `ReactLenis` —
 * **not** its parent. A parent effect therefore reads `undefined`, bails, and
 * never runs again.
 *
 * The failure is silent and asymmetric in a way that misleads: Lenis's own
 * wheel listener attaches regardless and calls `preventDefault`, so the wheel
 * is swallowed, while `raf` is never driven so nothing moves. The scrollbar and
 * the keyboard set the native scroll position directly, bypass Lenis's virtual
 * scroll entirely, and keep working — which makes it read as a wheel-specific
 * problem rather than as a dead animation loop.
 *
 * `useLenis()` reads the context `ReactLenis` publishes, so this component
 * re-renders the moment the instance exists. Keep the wiring here.
 *
 * ## One frame loop, and GSAP owns it
 *
 * `lenis.on("scroll", ScrollTrigger.update)` plus `gsap.ticker.add(raf)` is the
 * integration both libraries document. It matters more than usual on this page
 * because the centrepiece is a scrub: Lenis must advance and ScrollTrigger must
 * read the result within the same frame, or the scene lags the scroll by a tick
 * and the smoothing has bought nothing.
 *
 * `lagSmoothing(0)` is part of that contract — GSAP otherwise clamps the delta
 * it reports after a long frame, and `lenis.raf` would be handed a timestamp
 * that does not match elapsed time. The page's background-tab protection is
 * `runWhenVisible` in `lib/gsap.ts`, which is untouched and is what was doing
 * this job already.
 */
function LenisGsapBridge() {
  const lenis = useLenis();

  React.useEffect(() => {
    if (!lenis) return;

    const raf = (time: number) => {
      // GSAP's ticker reports seconds; Lenis expects milliseconds.
      lenis.raf(time * 1000);
    };

    lenis.on("scroll", ScrollTrigger.update);
    gsap.ticker.add(raf);
    gsap.ticker.lagSmoothing(0);

    return () => {
      lenis.off("scroll", ScrollTrigger.update);
      gsap.ticker.remove(raf);
      // Restore GSAP's documented defaults. The ticker is module-global and the
      // app routes share this GSAP instance, so leaving lag smoothing disabled
      // would outlive the marketing page.
      gsap.ticker.lagSmoothing(500, 33);
    };
  }, [lenis]);

  /**
   * Dev-only handles, for the same reason `core-scene.tsx` exposes
   * `__orkestApplyProgress`: browser automation runs this page with
   * `visibilityState === "hidden"`, where `requestAnimationFrame` fires zero
   * times per second. GSAP's ticker is frozen there, so no animated scroll of
   * any kind can be observed and a queued `scrollTo` looks identical to a dead
   * one — which is exactly how the ref bug above survived a browser check.
   *
   * `tick()` forces one ticker frame, so the whole chain can be driven by hand:
   *
   *   dispatchEvent(new WheelEvent('wheel', {deltaY: 400, cancelable: true}));
   *   for (let i = 0; i < 30; i++) __orkestScroll.tick();   // scrollY climbs
   */
  React.useEffect(() => {
    if (process.env.NODE_ENV === "production" || !lenis) return;
    const w = window as unknown as { __orkestScroll?: unknown };
    w.__orkestScroll = { lenis, tick: () => gsap.ticker.tick() };
    return () => {
      delete w.__orkestScroll;
    };
  }, [lenis]);

  return null;
}

/**
 * Owns the document scroll for the marketing route group.
 *
 * The rationale for smoothing this page at all is in `lib/smooth-scroll.ts`;
 * the frame-loop wiring and its one sharp edge are in `LenisGsapBridge` above.
 * Two things about this component itself:
 *
 * ## Always mounted, never conditionally rendered
 *
 * `usePrefersReducedMotion()` returns `false` on the server and on the first
 * client render, then settles to the real value (`hooks/use-media-query.ts`
 * documents the pessimistic server snapshot). Gating this component on it would
 * unmount and remount the entire marketing subtree on that settle — including
 * the WebGL canvas, which would lose its context and re-run the whole scene
 * setup. So reduced motion is expressed through the *options* instead, and only
 * the Lenis instance is rebuilt.
 *
 * ## It animates the REAL scroll position
 *
 * Used in window mode with no `wrapper`, so `position: sticky` still works,
 * `scrollY` still means what it says, and the scene's sticky stage, its 420vh
 * container and `sceneAnchorTopVh`'s absolute `vh` offset are all untouched. Do
 * not reach for a transform-based wrapper.
 *
 * `ScrollTrigger.normalizeScroll` must stay off — see `lib/gsap.ts`.
 */
export function SmoothScroll({ children }: { children: React.ReactNode }) {
  const reducedMotion = usePrefersReducedMotion();
  const options = React.useMemo(() => smoothScrollOptions(reducedMotion), [reducedMotion]);

  return (
    <ReactLenis root options={options}>
      <LenisGsapBridge />
      {children}
    </ReactLenis>
  );
}
