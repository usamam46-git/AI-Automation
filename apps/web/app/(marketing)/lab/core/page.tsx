"use client";

import dynamic from "next/dynamic";

/**
 * Throwaway lab route for building the 3D scene in isolation.
 *
 * **This route is deleted in Phase 5**, once the scene is wired into
 * `app/(marketing)/page.tsx`. It exists so the scene can be ugly, broken and
 * re-rolled a hundred times without any of that touching the live landing page,
 * which is already verified in a browser and shipping.
 *
 * `ssr: false` is required — the scene touches `window`, WebGL and
 * ScrollTrigger, none of which exist during prerender. Per Next 16's lazy
 * loading guide that option is only honoured inside a Client Component, which
 * is why this page carries `"use client"` despite rendering nothing itself.
 */
const CoreScene = dynamic(
  () => import("@/components/marketing/scene/core-scene").then((m) => m.CoreScene),
  {
    ssr: false,
    loading: () => <div className="h-screen w-full bg-[#eeece9]" />,
  },
);

export default function CoreLabPage() {
  return (
    <div className="bg-[#e2dfd8]">
      <CoreScene />

      {/* Runway. The scene's last frame should be able to settle before the
          page ends, or the final pull-back is cut off by the scroll bottom. */}
      <div className="h-[40vh]" />
    </div>
  );
}
