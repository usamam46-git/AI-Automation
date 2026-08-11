"use client";

import * as React from "react";
import { ShieldCheck, UserRound } from "lucide-react";

import { gsap } from "@/lib/gsap";
import { useGsapReveal } from "@/hooks/use-gsap-reveal";
import { cn } from "@/lib/utils";

/**
 * Inline icon badge set into the display type.
 *
 * `align-middle` plus a slight negative top margin is what keeps the chip
 * optically centred on a cap-height line — vertical-align alone sits it low
 * at display sizes.
 */
function InlineBadge({
  icon: Icon,
  tone,
  label,
}: {
  icon: React.ComponentType<{ className?: string }>;
  tone: "sky" | "lime";
  label: string;
}) {
  return (
    <span
      role="img"
      aria-label={label}
      className={cn(
        "mx-1 -mt-[0.12em] inline-flex size-[0.92em] shrink-0 items-center justify-center rounded-full align-middle",
        tone === "sky" ? "bg-mk-sky" : "bg-mk-lime",
      )}
    >
      <Icon className={cn("size-[0.52em]", tone === "sky" ? "text-white" : "text-mk-ink")} />
    </span>
  );
}

export function Statement() {
  const rootRef = React.useRef<HTMLElement>(null);

  useGsapReveal(rootRef, () => {
    // Line-by-line reveal. `once: true` — a statement that re-animates every
    // time it re-enters the viewport starts to feel like a slideshow.
    gsap.from("[data-statement-line]", {
      y: 30,
      opacity: 0,
      duration: 0.85,
      ease: "power3.out",
      stagger: 0.11,
      scrollTrigger: { trigger: rootRef.current, start: "top 72%", once: true },
      onComplete: () => gsap.set("[data-statement-line]", { clearProps: "all" }),
    });
  });

  return (
    <section ref={rootRef} className="bg-mk-paper px-5 py-24 sm:py-32">
      <div className="mx-auto max-w-4xl text-center">
        <p data-statement-line className="mk-eyebrow text-mk-ink-soft">
          Why we built it
        </p>

        <h2 className="mk-display mt-6 text-[1.875rem] text-mk-ink sm:text-[2.75rem] lg:text-[3.25rem]">
          <span data-statement-line className="block">
            A workflow engine for the work
          </span>
          <span data-statement-line className="block">
            that
            <InlineBadge icon={ShieldCheck} tone="sky" label="" />
            can&apos;t be wrong,
          </span>
          <span data-statement-line className="block text-mk-ink-soft">
            and the moments that
            <InlineBadge icon={UserRound} tone="lime" label="" />
            need a person.
          </span>
        </h2>

        <p
          data-statement-line
          className="mx-auto mt-8 max-w-xl text-[1.0625rem] leading-relaxed text-mk-ink-soft"
        >
          Most automation tools are proud of how little they ask you. In finance and HR, that is
          the wrong instinct. Orkest is built so that a workflow which moves money or changes a
          record cannot be published at all until there is a human checkpoint in front of it — not
          a setting you remember to switch on, a rule the platform refuses to let you skip.
        </p>
      </div>
    </section>
  );
}
