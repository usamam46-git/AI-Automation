"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Lock, ScrollText } from "lucide-react";

import { gsap, runWhenVisible } from "@/lib/gsap";
import { usePrefersReducedMotion } from "@/hooks/use-media-query";
import { InteractiveHoverButton } from "@/components/ui/interactive-hover-button";
import { HeroCollage } from "@/components/marketing/hero-collage";
import { SkyBackdrop } from "@/components/marketing/sky-backdrop";

/**
 * Capability facts in place of the usual star rating.
 *
 * The reference layout puts social proof here ("Rated 4.9/5 by 4,900+
 * clients"). Orkest has not shipped, so any rating would be invented — these
 * are three things the codebase actually does instead, which is both honest
 * and, for this buyer, more persuasive than a star count.
 */
const PROOF = [
  { icon: Lock, label: "Row-level tenant isolation" },
  { icon: ScrollText, label: "Append-only audit trail" },
  { icon: KeyRound, label: "Bring your own model key" },
] as const;

export function Hero() {
  const router = useRouter();
  const rootRef = React.useRef<HTMLDivElement>(null);
  const reducedMotion = usePrefersReducedMotion();

  React.useEffect(() => {
    if (reducedMotion) return;
    const root = rootRef.current;
    if (!root) return;

    let ctx: gsap.Context | undefined;

    const dispose = runWhenVisible(() => {
      ctx = gsap.context(() => {
        // One orchestrated entrance rather than per-element scroll reveals. The
        // hero is above the fold on load, so a scroll-triggered reveal here
        // would either fire instantly or never fire at all.
        //
        // `clearProps` on completion strips the inline styles GSAP wrote, so
        // the finished hero is styled purely by its classes — nothing is left
        // holding an inline `opacity` that a later interruption could freeze.
        const targets =
          "[data-hero-eyebrow], [data-hero-line], [data-hero-sub], [data-hero-cta], [data-hero-proof]";

        gsap
          .timeline({
            defaults: { ease: "power3.out" },
            onComplete: () => gsap.set(targets, { clearProps: "all" }),
          })
          .from("[data-hero-eyebrow]", { y: 14, opacity: 0, duration: 0.6 })
          .from("[data-hero-line]", { y: 26, opacity: 0, duration: 0.85, stagger: 0.09 }, "-=0.35")
          .from("[data-hero-sub]", { y: 16, opacity: 0, duration: 0.7 }, "-=0.5")
          .from("[data-hero-cta]", { y: 14, opacity: 0, duration: 0.6, stagger: 0.07 }, "-=0.4")
          .from("[data-hero-proof]", { opacity: 0, duration: 0.7 }, "-=0.3");
      }, root);
    });

    return () => {
      dispose();
      ctx?.revert();
    };
  }, [reducedMotion]);

  return (
    <section ref={rootRef} className="relative isolate overflow-hidden pb-8">
      <SkyBackdrop />

      <div className="relative z-10 mx-auto max-w-6xl px-5 pt-32 sm:pt-36 lg:pt-40">
        <div className="mx-auto max-w-3xl text-center">
          <p data-hero-eyebrow className="mk-eyebrow text-mk-sky-pale">
            Workflow automation for ERP, HR and Finance
          </p>

          <h1 className="mk-display mt-5 text-[2.75rem] text-white sm:text-6xl lg:text-[4.25rem]">
            <span data-hero-line className="block">
              Automation that knows
            </span>
            <span data-hero-line className="block text-mk-sky-pale">
              when to ask
            </span>
          </h1>

          <p
            data-hero-sub
            className="mx-auto mt-6 max-w-xl text-[1.0625rem] leading-relaxed font-medium text-white/95 sm:text-[1.125rem]"
            style={{ textShadow: "0 1px 2px rgba(6, 50, 95, 0.22)" }}
          >
            Orkest runs your back-office workflows end to end — reading documents, calling your
            systems, closing the loop. Then it stops for a person before anything touches your
            ledger.
          </p>

          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <span data-hero-cta>
              <InteractiveHoverButton
                text="Start building"
                tone="lime"
                onClick={() => router.push("/register")}
              />
            </span>
            <span data-hero-cta>
              <InteractiveHoverButton
                text="Watch a run"
                tone="glass"
                onClick={() =>
                  document.getElementById("how-it-works")?.scrollIntoView({ behavior: "smooth" })
                }
              />
            </span>
          </div>

          <ul
            data-hero-proof
            className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2.5"
          >
            {PROOF.map((item) => (
              <li key={item.label} className="flex items-center gap-1.5 text-[0.8125rem] text-white/85">
                <item.icon className="size-3.5 text-mk-lime" aria-hidden />
                {item.label}
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-12 sm:mt-14">
          <HeroCollage />
        </div>
      </div>
    </section>
  );
}
