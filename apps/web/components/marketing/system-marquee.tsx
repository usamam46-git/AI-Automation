"use client";

import * as React from "react";

import { gsap } from "@/lib/gsap";
import { usePrefersReducedMotion } from "@/hooks/use-media-query";

/**
 * The system strip directly under the hero.
 *
 * ## Why these are set as plain names
 *
 * Reproducing the vendors' actual marks would mean shipping their trademarked
 * assets or redrawing them from memory, and a subtly wrong Workday logo looks
 * worse than no logo at all. An earlier version compensated with coloured
 * monogram tiles, which was worse again — it read as an impression of a logo
 * wall rather than as a deliberate typographic choice. Names set in the site's
 * own display face are honest about what they are, and calmer.
 *
 * ## Why the heading says "connect to"
 *
 * A logo wall under a hero reads as "these are our customers" or "these are
 * our integrations", and neither is true yet: the FAQ further down this same
 * page says purpose-built ERP connectors are on the roadmap, and that today an
 * integration is an HTTP tool you configure yourself. The compatibility claim
 * *is* true — every system below has an HTTP API, which the tool registry
 * speaks — so the strip closes by repeating the FAQ's own wording, which is
 * what keeps the two from drifting apart. If real logos are ever added here,
 * that heading and that FAQ answer have to change with them.
 */

/**
 * Finance/ERP and HR systems interleaved, so the strip reads as both at a
 * glance rather than as two blocks.
 */
const SYSTEMS: readonly string[] = [
  "Workday",
  "NetSuite",
  "SAP",
  "Xero",
  "BambooHR",
  "QuickBooks",
  "Dynamics 365",
  "Gusto",
  "Sage Intacct",
  "Rippling",
  "Coupa",
  "ADP",
  "Oracle Fusion",
  "Bill",
] as const;

export function SystemMarquee() {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const tweenRef = React.useRef<gsap.core.Tween | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  React.useEffect(() => {
    if (reducedMotion) return;
    const root = rootRef.current;
    if (!root) return;

    const ctx = gsap.context(() => {
      // The track holds the list twice; translating by exactly -50% lands on a
      // byte-identical frame, so the loop has no visible seam.
      tweenRef.current = gsap.to("[data-marquee-track]", {
        xPercent: -50,
        duration: 52,
        ease: "none",
        repeat: -1,
      });
    }, root);

    return () => {
      tweenRef.current = null;
      ctx.revert();
    };
  }, [reducedMotion]);

  // Pause on hover so a name can actually be read, and on focus-within so a
  // keyboard user tabbing past is not chasing a moving target.
  const pause = () => tweenRef.current?.pause();
  const resume = () => tweenRef.current?.resume();

  return (
    <section
      aria-label="Systems Orkest can connect to"
      className="border-y border-[var(--mk-hairline)] bg-mk-paper py-10 sm:py-12"
    >
      <p className="mk-eyebrow mb-8 text-center text-mk-ink-soft">
        Connect to the systems your team already runs
      </p>

      <div
        ref={rootRef}
        className="relative overflow-hidden"
        onMouseEnter={pause}
        onMouseLeave={resume}
        onFocus={pause}
        onBlur={resume}
        style={{
          // A real alpha mask, not a paper-coloured overlay: the names fade to
          // transparent, so the strip sits correctly on any background and the
          // edges never show a seam where a fake fade would end.
          maskImage:
            "linear-gradient(to right, transparent 0%, #000 12%, #000 88%, transparent 100%)",
          WebkitMaskImage:
            "linear-gradient(to right, transparent 0%, #000 12%, #000 88%, transparent 100%)",
        }}
      >
        <div data-marquee-track className="flex w-max">
          {/* Duplicated for the seamless wrap. The copy is `aria-hidden` so a
              screen reader hears the list once. */}
          {[0, 1].map((copy) => (
            <ul key={copy} className="flex shrink-0 items-center" aria-hidden={copy === 1 || undefined}>
              {SYSTEMS.map((name) => (
                <li key={`${copy}-${name}`} className="flex shrink-0 items-center">
                  {/* Separator carried by each item rather than placed between
                      them, so the wrap point gets one too and the loop stays
                      evenly spaced across the seam. */}
                  <span aria-hidden className="size-[3px] shrink-0 rounded-full bg-mk-ink/15" />
                  <span className="px-8 font-[family-name:var(--font-display)] text-[1.25rem] font-medium tracking-tight whitespace-nowrap text-mk-ink-soft transition-colors duration-300 hover:text-mk-ink sm:text-[1.375rem]">
                    {name}
                  </span>
                </li>
              ))}
            </ul>
          ))}
        </div>
      </div>

      <p className="mt-8 text-center text-[0.8125rem] text-mk-ink-soft">
        Anything with an HTTP API, through the tool registry.
      </p>
    </section>
  );
}
