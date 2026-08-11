"use client";

import * as React from "react";

import { gsap } from "@/lib/gsap";
import { usePrefersReducedMotion } from "@/hooks/use-media-query";
import { AuroraCanvas } from "@/components/marketing/aurora-canvas";

/**
 * The hero sky.
 *
 * Built from layered blurred radial gradients rather than a photograph: the
 * repo ships no cloud imagery, and a procedural sky costs no bytes, scales to
 * any viewport without art-directed crops, and can drift continuously without
 * a video decode.
 *
 * The gradient stops are chosen for contrast, not just looks — the text block
 * sits between roughly 15% and 50% of this element's height, where the sky
 * stays at or below `#1878CC`. That is a 4.46:1 ratio against white, which
 * carries the 17–18px subhead as well as the display type. Lightening a stop
 * inside that band without re-checking will quietly break AA on the largest
 * text on the site; lighten below 50% instead, where only the collage sits.
 */
export function SkyBackdrop() {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const reducedMotion = usePrefersReducedMotion();

  React.useEffect(() => {
    if (reducedMotion) return;
    const root = rootRef.current;
    if (!root) return;

    const ctx = gsap.context(() => {
      // Each cloud band drifts on its own period so they never re-align into a
      // visible loop. Slow enough (60–110s) to read as weather, not motion.
      gsap.utils.toArray<HTMLElement>("[data-cloud]").forEach((cloud, i) => {
        gsap.to(cloud, {
          xPercent: i % 2 === 0 ? 14 : -12,
          yPercent: i % 3 === 0 ? -6 : 4,
          duration: 62 + i * 17,
          ease: "sine.inOut",
          repeat: -1,
          yoyo: true,
        });
      });
    }, root);

    return () => ctx.revert();
  }, [reducedMotion]);

  return (
    <div ref={rootRef} aria-hidden className="absolute inset-0 overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, #0a5aa0 0%, #1170c2 30%, #1878cc 50%, #3e9bee 66%, #8fcefa 82%, #dcefff 95%, #fafafa 100%)",
        }}
      />

      {/* Aurora sits directly on the gradient and under the clouds, so the
          cloud banks read as foreground weather passing in front of the glow
          rather than as a flat scrim over it. */}
      <AuroraCanvas />

      {/* Cloud banks. Heavily feathered white ellipses; opacity climbs toward
          the bottom where the sky is palest, so they dissolve into the page. */}
      <div
        data-cloud
        className="absolute -left-[10%] top-[38%] h-[46%] w-[70%] rounded-[50%] opacity-45 blur-[70px]"
        style={{ background: "radial-gradient(50% 50% at 50% 50%, #ffffff 0%, rgba(255,255,255,0) 72%)" }}
      />
      <div
        data-cloud
        className="absolute -right-[14%] top-[46%] h-[52%] w-[78%] rounded-[50%] opacity-55 blur-[80px]"
        style={{ background: "radial-gradient(50% 50% at 50% 50%, #ffffff 0%, rgba(255,255,255,0) 70%)" }}
      />
      <div
        data-cloud
        className="absolute left-[18%] top-[62%] h-[44%] w-[64%] rounded-[50%] opacity-70 blur-[64px]"
        style={{ background: "radial-gradient(50% 50% at 50% 50%, #ffffff 0%, rgba(255,255,255,0) 74%)" }}
      />
      <div
        data-cloud
        className="absolute left-[4%] top-[12%] h-[28%] w-[40%] rounded-[50%] opacity-20 blur-[60px]"
        style={{ background: "radial-gradient(50% 50% at 50% 50%, #ffffff 0%, rgba(255,255,255,0) 76%)" }}
      />

      {/* Fine grain. Without it the gradient bands on wide displays. */}
      <svg className="absolute inset-0 h-full w-full opacity-[0.035] mix-blend-overlay">
        <filter id="mk-sky-grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.75" numOctaves="3" stitchTiles="stitch" />
        </filter>
        <rect width="100%" height="100%" filter="url(#mk-sky-grain)" />
      </svg>

      {/* Hard seam remover: melts the last few pixels of sky into the paper
          background so the hero and the section below share no visible edge. */}
      <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-b from-transparent to-mk-paper" />
    </div>
  );
}
