"use client";

import dynamic from "next/dynamic";

import { RoomPlate } from "@/components/marketing/scene/room-plate";

/**
 * Client boundary for the 3D scene on the landing page.
 *
 * `app/(marketing)/page.tsx` is a Server Component, and per Next 16's lazy
 * loading guide `ssr: false` is only honoured inside a Client Component — so
 * this thin wrapper exists purely to be that boundary. The scene itself touches
 * `window`, WebGL and ScrollTrigger, none of which exist during prerender.
 *
 * ## The fallback is the opening frame, not a placeholder
 *
 * It used to be a plain block of `--mk-paper`, on the reasoning that a spinner
 * on a landing page hero advertises loading rather than arriving. Same
 * reasoning, better answer: render the photographed room itself, frozen at the
 * opening state. The plate is a 40KB JPEG in the initial markup, so the first
 * thing painted is the office — and when the scene chunk lands, the live plate
 * replaces this one with identical markup at identical geometry, which makes
 * the swap invisible rather than a flash of grey.
 *
 * It also means a visitor whose JS never arrives still gets the shot.
 */
const CoreScene = dynamic(
  () => import("@/components/marketing/scene/core-scene").then((m) => m.CoreScene),
  {
    ssr: false,
    loading: () => (
      <div className="relative h-screen w-full overflow-hidden bg-mk-paper">
        <RoomPlate frozen />
      </div>
    ),
  },
);

export function CoreSceneSection() {
  return <CoreScene />;
}
