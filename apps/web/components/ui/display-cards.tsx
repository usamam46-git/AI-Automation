"use client";

/**
 * Display Cards — a skewed, overlapping card stack.
 *
 * Adapted from the 21st.dev snippet. Changes from upstream, all to fit this
 * project's locked design system:
 *
 * - **No hardcoded blues.** Upstream paints `bg-blue-800` / `text-blue-300` /
 *   `text-blue-500`, which are the only saturated colours in an otherwise
 *   neutral product and would be the loudest thing on any screen they appear
 *   on. Everything here is `muted`/`border`/`foreground`, so the stack reads as
 *   paper rather than as a promo widget.
 * - **`rounded-xl` and soft borders**, matching the card/panel corner rule.
 * - **Reduced-motion aware**: the skew and the hover lift are transforms, so a
 *   reduced-motion user gets the stack flat and static rather than a 700ms
 *   translate on every pointer move.
 * - **Widths are fluid** (`w-full max-w-[22rem]`) instead of a fixed `22rem`,
 *   because a fixed-width skewed stack overflows a narrow viewport sideways and
 *   the document must never scroll horizontally.
 *
 * This is a decorative primitive. Use it for empty states and marketing-shaped
 * moments inside the app — never to display data a user has to read precisely,
 * because the 8-degree skew genuinely costs legibility.
 */

import type * as React from "react";
import { cn } from "@/lib/utils";

export interface DisplayCardProps {
  className?: string;
  icon?: React.ReactNode;
  title?: string;
  description?: string;
  meta?: string;
  iconClassName?: string;
  titleClassName?: string;
}

export function DisplayCard({
  className,
  icon,
  title = "Featured",
  description = "Discover amazing content",
  meta = "Just now",
  iconClassName,
  titleClassName,
}: DisplayCardProps) {
  return (
    <div
      className={cn(
        "relative flex h-36 w-full max-w-[22rem] -skew-y-[8deg] select-none flex-col justify-between",
        "rounded-xl border border-border/70 bg-card/70 px-4 py-3 backdrop-blur-sm",
        "shadow-sm shadow-black/5 transition-all duration-500 ease-out",
        "after:absolute after:-right-1 after:top-[-5%] after:h-[110%] after:w-[18rem] after:content-['']",
        "after:bg-gradient-to-l after:from-background after:to-transparent",
        "hover:border-border hover:bg-card",
        "motion-reduce:transform-none motion-reduce:transition-none",
        "[&>*]:flex [&>*]:items-center [&>*]:gap-2",
        className,
      )}
    >
      <div>
        {icon ? (
          <span
            className={cn(
              "relative inline-flex items-center justify-center rounded-full border border-border/70 bg-muted p-1.5 text-muted-foreground",
              iconClassName,
            )}
          >
            {icon}
          </span>
        ) : null}
        <p className={cn("text-sm font-medium tracking-tight", titleClassName)}>{title}</p>
      </div>
      <p className="truncate text-sm text-foreground/80">{description}</p>
      <p className="text-xs text-muted-foreground">{meta}</p>
    </div>
  );
}

/**
 * The three stack positions. Kept as a constant rather than inlined so a caller
 * supplying its own cards gets the layered geometry for free by index, and so
 * the grid-area trick (all three in one cell) lives in exactly one place.
 */
const STACK_POSITIONS = [
  "[grid-area:stack] hover:-translate-y-8 grayscale-[70%] hover:grayscale-0",
  "[grid-area:stack] translate-x-10 translate-y-8 hover:-translate-y-1 grayscale-[70%] hover:grayscale-0",
  "[grid-area:stack] translate-x-20 translate-y-16 hover:translate-y-10",
];

export default function DisplayCards({ cards }: { cards?: DisplayCardProps[] }) {
  const displayCards = cards?.length ? cards : [{}, {}, {}];

  return (
    <div className="grid place-items-center [grid-template-areas:'stack']">
      {displayCards.map((cardProps, index) => (
        <DisplayCard
          key={cardProps.title ?? index}
          {...cardProps}
          className={cn(STACK_POSITIONS[index % STACK_POSITIONS.length], cardProps.className)}
        />
      ))}
    </div>
  );
}
