"use client";

import * as React from "react";

/**
 * Subscribes to a media query.
 *
 * Returns `false` on the server and on the first client render, then settles to
 * the real value — `useSyncExternalStore`'s server snapshot is deliberately
 * pessimistic so SSR markup never claims a viewport it cannot know. Callers
 * must therefore treat `false` as "not yet known to match" and keep the
 * no-match branch renderable, not as a positive assertion of a small viewport.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );

  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Honours the OS "reduce motion" setting. Every GSAP entry point checks this. */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}
