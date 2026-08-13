"use client";

import * as React from "react";
import { ArrowRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The 21st.dev interactive hover button.
 *
 * Two deviations from the source snippet, both deliberate:
 *
 * 1. **Width is intrinsic, not the fixed `w-32`.** The original translates the
 *    outgoing label by a hard-coded `translate-x-12`, which only lands
 *    correctly at one width. Here the incoming layer is `inset-0` + centered,
 *    so a label of any length stays centred and the mechanic survives
 *    "Start building" as well as it survives "Button".
 * 2. **`tone` replaces the hard-coded `bg-primary` fill.** The buttons sit on
 *    surfaces that vary from a light wall to dark walnut, so the expanding dot
 *    is tokenised per surface rather than assuming one background.
 */
const TONES = {
  lime: {
    base: "border-mk-lime bg-mk-lime text-mk-ink",
    fill: "bg-mk-ink",
    incoming: "text-mk-lime",
  },
  ink: {
    base: "border-mk-ink bg-mk-ink text-white",
    fill: "bg-mk-lime",
    incoming: "text-mk-ink",
  },
  glass: {
    base: "mk-glass border-white/30 text-white",
    fill: "bg-white",
    incoming: "text-mk-sky-deep",
  },
  /**
   * The office hero's primary: ink, with no green anywhere in it.
   *
   * The lime pill was deepened once and still read as neon sitting on a walnut
   * desk — a saturated yellow-green against warm timber is a fight no amount of
   * tuning wins. Near-black with white text is what a primary button looks like
   * on furniture. Note the fill is **white**, not lime: the `ink` tone expands a
   * lime dot on hover, which would put the neon straight back.
   *
   * Lime is not gone from the page — it is still the nav pill and still the
   * accent rule on every document. It is just no longer a large area of colour
   * on top of wood.
   */
  solid: {
    base: "border-mk-ink bg-mk-ink text-white",
    fill: "bg-white",
    incoming: "text-mk-ink",
  },
  /**
   * The quiet secondary, for the office hero.
   *
   * Two heavy buttons side by side — a bright lime pill next to a solid black
   * one — was half of why the pair looked wrong against walnut and macOS grey.
   * A primary carries the weight and a secondary should not compete with it, so
   * this is paper with a hairline and ink text, and it fills to ink on hover.
   */
  quiet: {
    base: "border-mk-hairline bg-white/85 text-mk-ink",
    fill: "bg-mk-ink",
    incoming: "text-white",
  },
} as const;

export type InteractiveHoverButtonTone = keyof typeof TONES;

interface InteractiveHoverButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  text?: string;
  tone?: InteractiveHoverButtonTone;
}

const InteractiveHoverButton = React.forwardRef<HTMLButtonElement, InteractiveHoverButtonProps>(
  ({ text = "Button", tone = "lime", className, ...props }, ref) => {
    const t = TONES[tone];

    return (
      <button
        ref={ref}
        className={cn(
          "group relative cursor-pointer overflow-hidden rounded-full border px-6 py-3",
          "text-center text-[0.9375rem] font-semibold tracking-tight",
          "transition-colors duration-300 outline-none",
          "focus-visible:ring-3 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent",
          t.base,
          className,
        )}
        {...props}
      >
        {/* Outgoing label — slides right and fades. */}
        <span className="relative z-20 inline-block transition-all duration-300 ease-out group-hover:translate-x-3 group-hover:opacity-0">
          {text}
        </span>

        {/* Incoming label — slides in from the left with the arrow. */}
        <span
          className={cn(
            "absolute inset-0 z-20 flex -translate-x-3 items-center justify-center gap-2",
            "opacity-0 transition-all duration-300 ease-out",
            "group-hover:translate-x-0 group-hover:opacity-100",
            t.incoming,
          )}
        >
          <span>{text}</span>
          <ArrowRight className="size-4" />
        </span>

        {/* The dot that blooms to fill the button.
            Hidden at rest, unlike the 21st.dev original. That version sits a
            dark dot on a white button at `left-[20%]`, which works at its
            fixed `w-32`; at intrinsic width the dot lands hard against the
            first character and reads as a bullet point — and on the lime
            variant it is the same colour as the label, so it reads as a bullet
            no matter where it sits. Fading it in as it blooms keeps the
            expanding-circle mechanic and loses the artifact. */}
        <span
          aria-hidden
          className={cn(
            "absolute top-1/2 left-3 z-10 size-2 -translate-y-1/2 rounded-full opacity-0",
            "transition-all duration-300 ease-out",
            "group-hover:left-0 group-hover:top-0 group-hover:h-full group-hover:w-full",
            "group-hover:-translate-y-0 group-hover:scale-125 group-hover:rounded-none group-hover:opacity-100",
            t.fill,
          )}
        />
      </button>
    );
  },
);

InteractiveHoverButton.displayName = "InteractiveHoverButton";

export { InteractiveHoverButton };
