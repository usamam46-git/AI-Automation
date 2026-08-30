"use client";

import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

/**
 * Single GSAP entry point for the marketing surface.
 *
 * `registerPlugin` is idempotent but must not run during SSR — ScrollTrigger
 * touches `document` at registration time. Importing this module from a
 * `"use client"` component is safe because Next only evaluates it in the
 * browser bundle; the `typeof window` guard covers the pre-hydration pass.
 */
if (typeof window !== "undefined") {
  gsap.registerPlugin(ScrollTrigger);

  // The page is long and pins two sections, and on iOS the address bar
  // collapsing on the first flick fires a resize that re-triggers every one of
  // them. Ignoring that class of resize is the fix.
  //
  // This is NOT `ScrollTrigger.normalizeScroll()`, which this file has never
  // called and now must never call: `components/marketing/smooth-scroll.tsx`
  // gives the scroll position to Lenis, and normalizeScroll takes it over too.
  // Two owners of one scroll position is a fight neither wins.
  ScrollTrigger.config({ ignoreMobileResize: true });
}

/**
 * Defers an entrance animation until the document is actually visible.
 *
 * Entrance timelines built with `gsap.from` set their targets to `opacity: 0`
 * the instant they are created, and rely on the ticker to bring them back.
 * The ticker is driven by `requestAnimationFrame`, which browsers do not run
 * in a background tab — so a page opened via cmd-click or "open in new tab"
 * builds its timeline, blanks the hero, and then freezes there until the tab
 * is foregrounded. Anything that stops the ticker permanently (a throttled
 * renderer, a crashed frame loop) leaves the content invisible for good.
 *
 * Waiting for visibility fixes both halves: the content stays in its natural
 * painted state until we know frames are being produced, and the animation is
 * not wasted playing to nobody.
 *
 * Returns a disposer that must be called from the effect cleanup — without it
 * a component unmounted while still hidden leaks the listener.
 */
export function runWhenVisible(run: () => void): () => void {
  if (typeof document === "undefined") return () => {};

  if (document.visibilityState === "visible") {
    run();
    return () => {};
  }

  const onVisible = () => {
    if (document.visibilityState !== "visible") return;
    document.removeEventListener("visibilitychange", onVisible);
    run();
  };

  document.addEventListener("visibilitychange", onVisible);
  return () => document.removeEventListener("visibilitychange", onVisible);
}

export { gsap, ScrollTrigger };
