"use client";

import * as React from "react";
import Link from "next/link";
import NumberFlow from "@number-flow/react";
import confetti from "canvas-confetti";
import { Check, Star } from "lucide-react";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { gsap } from "@/lib/gsap";
import { useGsapReveal } from "@/hooks/use-gsap-reveal";
import { useMediaQuery, usePrefersReducedMotion } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";

/**
 * Pricing block, adapted from the 21st.dev component.
 *
 * Two substitutions from the original snippet:
 *
 * 1. **GSAP replaces framer-motion.** The page already loads GSAP for the run
 *    film; pulling in a second animation runtime for three card entrances
 *    would roughly double the animation payload for no new capability.
 * 2. **The confetti palette is literal hex, not `hsl(var(--primary))`.**
 *    canvas-confetti parses colours itself and cannot resolve a CSS custom
 *    property, so the original's `colors` array silently falls back to its
 *    defaults. These are the marketing palette's real values.
 *
 * The perspective fan (outer cards pushed back and rotated) is kept, but only
 * above `md` — at phone width the cards stack, and a rotated stack just looks
 * broken.
 */
export interface PricingPlan {
  name: string;
  price: string;
  yearlyPrice: string;
  period: string;
  features: string[];
  description: string;
  buttonText: string;
  href: string;
  isPopular: boolean;
}

export const ORKEST_PLANS: PricingPlan[] = [
  {
    name: "Starter",
    price: "49",
    yearlyPrice: "39",
    period: "month",
    features: [
      "2,000 runs per month",
      "Up to 5 published workflows",
      "Webhook and schedule triggers",
      "30-day run history",
      "Community support",
    ],
    description: "For a first workflow you want to trust before you scale it.",
    buttonText: "Start free",
    href: "/register",
    isPopular: false,
  },
  {
    name: "Team",
    price: "199",
    yearlyPrice: "159",
    period: "month",
    features: [
      "25,000 runs per month",
      "Unlimited workflows and workspaces",
      "Roles, approvals and audit trail",
      "Bring your own model key",
      "1-year run history",
      "Priority support",
    ],
    description: "For a finance or ops team running the back office on it.",
    buttonText: "Start free",
    href: "/register",
    isPopular: true,
  },
  {
    name: "Enterprise",
    price: "699",
    yearlyPrice: "559",
    period: "month",
    features: [
      "Custom run volume",
      "SSO and SCIM provisioning",
      "Self-hosted or private cloud",
      "Custom ERP connectors",
      "Unlimited run history",
      "Named support engineer and SLA",
    ],
    description: "For regulated teams that need the trail to satisfy an auditor.",
    buttonText: "Talk to us",
    href: "#contact",
    isPopular: false,
  },
];

export function Pricing({
  plans = ORKEST_PLANS,
  title = "Priced on runs, not seats",
  description = "Invite the whole finance team without thinking about it. Every plan includes the approval gate, the audit trail and tenant isolation — those are not an upgrade.",
}: {
  plans?: PricingPlan[];
  title?: string;
  description?: string;
}) {
  const [isMonthly, setIsMonthly] = React.useState(true);
  const rootRef = React.useRef<HTMLElement>(null);
  const switchRef = React.useRef<HTMLButtonElement>(null);
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const reducedMotion = usePrefersReducedMotion();

  useGsapReveal(rootRef, () => {
    gsap.from("[data-plan]", {
      y: 46,
      opacity: 0,
      duration: 0.8,
      ease: "power3.out",
      stagger: 0.1,
      scrollTrigger: { trigger: rootRef.current, start: "top 74%", once: true },
      onComplete: () => gsap.set("[data-plan]", { clearProps: "all" }),
    });
  });

  const handleToggle = (checked: boolean) => {
    setIsMonthly(!checked);

    if (!checked || reducedMotion) return;
    const node = switchRef.current;
    if (!node) return;

    const rect = node.getBoundingClientRect();
    confetti({
      particleCount: 50,
      spread: 60,
      origin: {
        x: (rect.left + rect.width / 2) / window.innerWidth,
        y: (rect.top + rect.height / 2) / window.innerHeight,
      },
      colors: ["#c8f536", "#3e9bee", "#0e6dc2", "#a8dbff"],
      ticks: 200,
      gravity: 1.2,
      decay: 0.94,
      startVelocity: 30,
      shapes: ["circle"],
      disableForReducedMotion: true,
    });
  };

  return (
    <section ref={rootRef} id="pricing" className="bg-mk-paper px-5 pb-24 sm:pb-32">
      <div className="mx-auto max-w-6xl">
        <div className="mx-auto max-w-2xl text-center">
          <p className="mk-eyebrow text-mk-sky-deep">Pricing</p>
          <h2 className="mk-display mt-3 text-[2rem] text-mk-ink sm:text-[2.75rem]">{title}</h2>
          <p className="mt-4 text-[1.0625rem] leading-relaxed text-mk-ink-soft">{description}</p>
        </div>

        <div className="mt-10 mb-12 flex items-center justify-center gap-3">
          <Label
            htmlFor="billing-period"
            className={cn(
              "text-[0.9375rem] font-medium transition-colors",
              isMonthly ? "text-mk-ink" : "text-mk-ink-soft",
            )}
          >
            Monthly
          </Label>
          <Switch
            id="billing-period"
            ref={switchRef}
            checked={!isMonthly}
            onCheckedChange={handleToggle}
            aria-label="Switch to annual billing"
          />
          <Label
            htmlFor="billing-period"
            className={cn(
              "text-[0.9375rem] font-medium transition-colors",
              isMonthly ? "text-mk-ink-soft" : "text-mk-ink",
            )}
          >
            Annual
            <span className="ml-1.5 rounded-full bg-mk-lime px-2 py-0.5 text-[11px] font-semibold text-mk-ink">
              Save 20%
            </span>
          </Label>
        </div>

        <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-3">
          {plans.map((plan) => (
            <article
              key={plan.name}
              data-plan
              className={cn(
                "relative flex flex-col rounded-3xl border bg-white p-6",
                plan.isPopular
                  ? "border-mk-ink shadow-[0_1px_2px_rgba(20,20,20,0.05),0_16px_40px_-12px_rgba(20,20,20,0.16)] md:-translate-y-4 md:scale-[1.03]"
                  : "border-[var(--mk-hairline)] mk-lift",
                // The fan only makes sense once the cards sit side by side.
                !plan.isPopular && isDesktop && "md:scale-[0.97]",
              )}
            >
              {plan.isPopular ? (
                <span className="absolute -top-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-mk-ink px-3 py-1 text-[11px] font-semibold whitespace-nowrap text-white">
                  <Star className="size-3 fill-mk-lime text-mk-lime" aria-hidden />
                  Most chosen
                </span>
              ) : null}

              <p className="text-[0.8125rem] font-semibold tracking-wide text-mk-ink-soft uppercase">
                {plan.name}
              </p>

              <div className="mt-5 flex items-baseline gap-1.5">
                {/* The `$` is a literal and the number is formatted as a plain
                    decimal, rather than `style: "currency"`. Intl renders USD
                    as "US$49" under a non-US locale — which is what this
                    actually shipped as on first render. Same trap, and the same
                    fix, as `formatMonthlyCost` in `lib/dashboard-stats.ts`. */}
                <span
                  className="mk-display text-[3rem] text-mk-ink"
                  // Labelled as a whole: NumberFlow splits digits across many
                  // elements to animate them, which a screen reader would
                  // otherwise announce one at a time.
                  aria-label={`${isMonthly ? plan.price : plan.yearlyPrice} US dollars per ${plan.period}`}
                >
                  <span aria-hidden>$</span>
                  <NumberFlow
                    value={Number(isMonthly ? plan.price : plan.yearlyPrice)}
                    format={{ style: "decimal", maximumFractionDigits: 0 }}
                    locales="en-US"
                    transformTiming={{ duration: 500, easing: "ease-out" }}
                    willChange
                    className="tabular-nums"
                  />
                </span>
                <span className="text-[0.875rem] font-medium text-mk-ink-soft">/ {plan.period}</span>
              </div>
              <p className="mt-1 text-[0.75rem] text-mk-ink-soft">
                {isMonthly ? "billed monthly" : "billed annually"}
              </p>

              <ul className="mt-6 flex flex-col gap-2.5">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2.5">
                    <Check className="mt-[3px] size-3.5 shrink-0 text-mk-sky-deep" aria-hidden />
                    <span className="text-[0.875rem] leading-snug text-mk-ink">{feature}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-7 flex flex-1 flex-col justify-end">
                <Link
                  href={plan.href}
                  className={cn(
                    "flex w-full items-center justify-center rounded-full px-5 py-3 text-[0.9375rem] font-semibold tracking-tight transition-colors outline-none focus-visible:ring-3 focus-visible:ring-mk-sky/40",
                    plan.isPopular
                      ? "bg-mk-lime text-mk-ink hover:bg-mk-lime-deep"
                      : "border border-mk-ink/15 bg-white text-mk-ink hover:bg-mk-mist",
                  )}
                >
                  {plan.buttonText}
                </Link>
                <p className="mt-4 text-[0.75rem] leading-relaxed text-mk-ink-soft">
                  {plan.description}
                </p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
