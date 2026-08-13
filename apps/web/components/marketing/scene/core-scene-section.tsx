"use client";

import dynamic from "next/dynamic";

/**
 * Client boundary for the 3D scene on the landing page.
 *
 * `app/(marketing)/page.tsx` is a Server Component, and per Next 16's lazy
 * loading guide `ssr: false` is only honoured inside a Client Component — so
 * this thin wrapper exists purely to be that boundary. The scene itself touches
 * `window`, WebGL and ScrollTrigger, none of which exist during prerender.
 *
 * The fallback is a plain block in the room's own opening colour rather than a
 * spinner: the section is a scroll stage, and a spinner on a landing page hero
 * advertises that something is loading rather than simply arriving.
 */
const CoreScene = dynamic(
  () => import("@/components/marketing/scene/core-scene").then((m) => m.CoreScene),
  {
    ssr: false,
    loading: () => <div className="h-screen w-full bg-mk-paper" />,
  },
);

export function CoreSceneSection() {
  return <CoreScene />;
}
