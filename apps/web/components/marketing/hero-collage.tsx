"use client";

import * as React from "react";
import { Check, Clock3, Coins, ShieldCheck, Zap } from "lucide-react";

import { gsap, runWhenVisible } from "@/lib/gsap";
import { usePrefersReducedMotion } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";

/**
 * The fanned card collage under the hero headline.
 *
 * Every card is a real Orkest artifact — a run row, a cost roll-up, an
 * approval interrupt — rather than generic dashboard filler. The centre card
 * is the approval gate, deliberately: it is the page's argument, and giving it
 * the collage's focal position means the thesis is legible before a single
 * word of body copy is read.
 *
 * Depth is faked with three levers that move together: scale, vertical offset
 * and blur. `depth` 0 is the focal card; higher values sit further back.
 */
interface CollageCard {
  id: string;
  depth: 0 | 1 | 2;
  /** Rotation in degrees. Signed to fan outward from the centre. */
  tilt: number;
  /**
   * Horizontally centres the card on its `left` anchor. Expressed as a flag
   * rather than a `-translate-x-1/2` class for the same reason as `scale`
   * below — Tailwind's translate utilities compile to `transform`, which the
   * GSAP parallax overwrites.
   */
  centered?: boolean;
  className: string;
  content: React.ReactNode;
}

function Row({ label, value, tone }: { label: string; value: string; tone?: "ok" | "wait" }) {
  return (
    <div className="flex items-center justify-between gap-3 py-[5px]">
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            tone === "wait" ? "bg-amber-400" : "bg-emerald-500",
          )}
        />
        <span className="truncate text-[10px] font-medium text-mk-ink/70">{label}</span>
      </div>
      <span className="shrink-0 font-[family-name:var(--font-jetbrains-mono)] text-[10px] tabular-nums text-mk-ink">
        {value}
      </span>
    </div>
  );
}

const CARDS: CollageCard[] = [
  {
    id: "quota",
    depth: 2,
    tilt: -9,
    className: "left-[0%] top-[30%] w-[132px] sm:w-[150px]",
    content: (
      <>
        <Zap className="mb-2 size-3.5 text-mk-sky-deep" />
        <p className="text-[10px] leading-tight font-medium text-mk-ink-soft">Runs today</p>
        <p className="mt-1 font-[family-name:var(--font-jetbrains-mono)] text-lg leading-none font-semibold tabular-nums text-mk-ink">
          412
          <span className="text-[10px] font-normal text-mk-ink-soft"> / 1,000</span>
        </p>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-mk-mist">
          <div className="h-full w-[41%] rounded-full bg-mk-sky" />
        </div>
      </>
    ),
  },
  {
    id: "runs",
    depth: 1,
    tilt: -5,
    className: "left-[13%] top-[10%] w-[168px] sm:w-[190px]",
    content: (
      <>
        <p className="mb-1.5 text-[10px] font-semibold tracking-tight text-mk-ink">Recent runs</p>
        <Row label="invoice_approval" value="39.2s" />
        <Row label="onboard_employee" value="12.8s" />
        <Row label="close_period" value="pending" tone="wait" />
        <Row label="sync_vendors" value="4.1s" />
      </>
    ),
  },
  {
    id: "cost",
    depth: 1,
    tilt: -2,
    className: "left-[27.5%] top-[38%] w-[150px] sm:w-[168px]",
    content: (
      <>
        <Coins className="mb-2 size-3.5 text-mk-ink-soft" />
        <p className="text-[10px] leading-tight font-medium text-mk-ink-soft">Cost this month</p>
        <p className="mt-1 font-[family-name:var(--font-jetbrains-mono)] text-xl leading-none font-semibold tabular-nums text-mk-ink">
          $842.10
        </p>
        <p className="mt-1.5 text-[9px] text-mk-ink-soft">Metered per node, not per seat</p>
      </>
    ),
  },
  {
    // Focal card. Sits highest, largest, unblurred, dead centre.
    id: "approval",
    depth: 0,
    tilt: 0,
    centered: true,
    className: "left-1/2 top-[2%] w-[196px] sm:w-[224px]",
    content: (
      <>
        <div className="mb-2 flex items-center gap-1.5">
          <span className="flex size-4 items-center justify-center rounded-full bg-amber-400/20">
            <Clock3 className="size-2.5 text-amber-600" />
          </span>
          <span className="text-[9px] font-semibold tracking-wide text-amber-700 uppercase">
            Waiting for approval
          </span>
        </div>
        <p className="text-[13px] leading-snug font-semibold tracking-tight text-mk-ink">
          Post $4,200.00 to Acme Vendor LLC?
        </p>
        <p className="mt-1 font-[family-name:var(--font-jetbrains-mono)] text-[9px] text-mk-ink-soft">
          approval_1 · run_a41f8c
        </p>
        <div className="mt-3 flex gap-1.5">
          <span className="flex-1 rounded-lg bg-mk-ink py-1.5 text-center text-[10px] font-semibold text-white">
            Approve
          </span>
          <span className="rounded-lg border border-[var(--mk-hairline)] px-2.5 py-1.5 text-[10px] font-medium text-mk-ink-soft">
            Reject
          </span>
        </div>
      </>
    ),
  },
  {
    id: "audit",
    depth: 1,
    tilt: 3,
    className: "right-[26.5%] top-[37%] w-[156px] sm:w-[174px]",
    content: (
      <div className="text-white">
        <ShieldCheck className="mb-2 size-3.5 text-mk-lime" />
        <p className="text-[11px] leading-snug font-medium tracking-tight">
          Audit rows reject <span className="font-[family-name:var(--font-jetbrains-mono)]">UPDATE</span> and{" "}
          <span className="font-[family-name:var(--font-jetbrains-mono)]">DELETE</span>.
        </p>
      </div>
    ),
  },
  {
    id: "tokens",
    depth: 2,
    tilt: 7,
    className: "right-[12%] top-[10%] w-[142px] sm:w-[160px]",
    content: (
      <>
        <p className="text-[10px] leading-tight font-medium text-mk-ink/70">Tokens this run</p>
        <p className="mt-1 font-[family-name:var(--font-jetbrains-mono)] text-lg leading-none font-semibold tabular-nums text-mk-ink">
          3,412
        </p>
        <div className="mt-2 flex items-end gap-[3px]">
          {[40, 62, 34, 78, 52, 90, 46].map((h, i) => (
            <span key={i} className="w-[5px] rounded-sm bg-mk-ink/15" style={{ height: `${h * 0.22}px` }} />
          ))}
        </div>
      </>
    ),
  },
  {
    id: "done",
    depth: 2,
    tilt: 11,
    className: "right-[0%] top-[30%] w-[128px] sm:w-[144px]",
    content: (
      <>
        <span className="mb-2 flex size-4 items-center justify-center rounded-full bg-emerald-500/15">
          <Check className="size-2.5 text-emerald-600" />
        </span>
        <p className="text-[10px] leading-snug font-medium text-mk-ink">
          Posted to NetSuite
        </p>
        <p className="mt-1 font-[family-name:var(--font-jetbrains-mono)] text-[9px] text-mk-ink-soft">
          AP-88401-2291
        </p>
      </>
    ),
  },
];

/**
 * Depth is split across two mechanisms on purpose.
 *
 * `z-index` and `filter: blur()` are safe as Tailwind classes, but scale is
 * NOT: Tailwind's `scale-*` compiles to `transform`, and GSAP's pointer
 * parallax writes `x`/`y` to that same `transform` property — so the class
 * would be silently wiped on the first pointer move and every card would snap
 * to full size. The standalone CSS `scale` property composes with `transform`
 * instead of competing for it, so it is applied inline below.
 */
const DEPTH_CLASS: Record<CollageCard["depth"], string> = {
  0: "z-30 blur-0",
  1: "z-20 blur-[0.4px]",
  2: "z-10 blur-[1.1px]",
};

const DEPTH_SCALE: Record<CollageCard["depth"], number> = {
  0: 1,
  1: 0.93,
  2: 0.86,
};

export function HeroCollage() {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const reducedMotion = usePrefersReducedMotion();

  React.useEffect(() => {
    if (reducedMotion) return;
    const root = rootRef.current;
    if (!root) return;

    let ctx: gsap.Context | undefined;

    const dispose = runWhenVisible(() => {
      ctx = gsap.context(() => {
        const cards = gsap.utils.toArray<HTMLElement>("[data-collage-card]");

        // Entrance: cards rise and settle, focal card last so the eye lands on
        // it. `clearProps` is limited to `opacity` — `x`/`y` must survive,
        // because the pointer parallax below writes to them continuously.
        gsap.from(cards, {
          y: 42,
          opacity: 0,
          duration: 0.9,
          ease: "power3.out",
          stagger: { each: 0.06, from: "edges" },
          delay: 0.25,
          onComplete: () => gsap.set(cards, { clearProps: "opacity" }),
        });

      // Pointer parallax. `quickTo` writes straight to the transform on each
      // move instead of building a tween per event — at 120Hz the naive
      // version allocates thousands of tweens a second.
      const movers = cards.map((card) => ({
        depth: Number(card.dataset.depth ?? 0),
        x: gsap.quickTo(card, "x", { duration: 0.7, ease: "power3.out" }),
        y: gsap.quickTo(card, "y", { duration: 0.7, ease: "power3.out" }),
      }));

      const onMove = (event: PointerEvent) => {
        const bounds = root.getBoundingClientRect();
        const dx = (event.clientX - bounds.left) / bounds.width - 0.5;
        const dy = (event.clientY - bounds.top) / bounds.height - 0.5;
        for (const mover of movers) {
          // Cards further back move less: real parallax, inverted from the
          // usual instinct to move the background more.
          const amount = 26 - mover.depth * 7;
          mover.x(dx * amount);
          mover.y(dy * amount * 0.55);
        }
      };

      const onLeave = () => {
        for (const mover of movers) {
          mover.x(0);
          mover.y(0);
        }
      };

        // Coarse pointers get no parallax — on touch the only "pointermove" is
        // a drag, which would yank the collage sideways mid-scroll. Returning a
        // function from a gsap.context callback registers it as the context's
        // own cleanup, so `ctx.revert()` below also unbinds these listeners.
        if (window.matchMedia("(pointer: fine)").matches) {
          window.addEventListener("pointermove", onMove, { passive: true });
          root.addEventListener("pointerleave", onLeave);
          return () => {
            window.removeEventListener("pointermove", onMove);
            root.removeEventListener("pointerleave", onLeave);
          };
        }
      }, root);
    });

    return () => {
      dispose();
      ctx?.revert();
    };
  }, [reducedMotion]);

  return (
    <div
      ref={rootRef}
      aria-hidden
      className="pointer-events-none relative mx-auto h-[250px] w-full max-w-6xl sm:h-[290px]"
    >
      {CARDS.map((card) => (
        <div
          key={card.id}
          data-collage-card
          data-depth={card.depth}
          className={cn(
            "absolute rounded-2xl border p-3 mk-lift-sky",
            card.id === "audit"
              ? "border-white/10 bg-mk-ink"
              : "border-white/60 bg-white/95 backdrop-blur-sm",
            DEPTH_CLASS[card.depth],
            card.className,
          )}
          style={{
            rotate: `${card.tilt}deg`,
            scale: DEPTH_SCALE[card.depth],
            ...(card.centered ? { translate: "-50% 0" } : null),
          }}
        >
          {card.content}
        </div>
      ))}
    </div>
  );
}
