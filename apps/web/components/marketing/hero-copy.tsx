"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useLenis } from "lenis/react";
import { KeyRound, Lock, ScrollText } from "lucide-react";

import { InteractiveHoverButton } from "@/components/ui/interactive-hover-button";

/**
 * The hero copy, over the office.
 *
 * ## What changed and why
 *
 * This used to sit on a sky-blue gradient with an aurora shader behind it and a
 * collage of floating UI cards beneath it. The product owner's call was to open
 * the page **in the office instead** — a real desk with the company's documents
 * on it, with the whole scroll narrative starting from there. The sky, the
 * aurora and the collage are gone; `sky-backdrop.tsx`, `aurora-canvas.tsx` and
 * `hero-collage.tsx` went with them.
 *
 * The words did not change. They are the page's conversion and they were
 * already right; only the surface behind them did.
 *
 * ## Neither button is lime
 *
 * The buttons sit on the walnut desk, and a saturated yellow-green on warm
 * timber reads as neon no matter how far it is deepened — it was tuned twice
 * and rejected twice. The primary is ink with white text, the secondary is
 * paper with a hairline. Lime survives where it still works: the nav pill and
 * the accent rule on every document.
 *
 * ## The type is nearly opaque ink, and that is a contrast requirement
 *
 * This copy has been retuned twice for two different backgrounds. It began as
 * white with a text-shadow over a blue gradient. It then became low-opacity ink
 * over a modelled near-white wall, where `text-mk-ink/45` on a flat #f2f2f5
 * surface is an elegant 7:1 and the docstring here claimed it needed "no
 * shadow, no scrim and no envelope".
 *
 * **That claim is void over a photograph, and the failure mode is worth knowing:
 * translucent ink has a contrast ceiling that no background can lift.** Ink at
 * 45% reaches only ~3.4:1 even on pure white, so on the plate the second
 * headline line measured 1.0:1 — literally invisible in its worst patch — and no
 * amount of scrim could have fixed it. `text-mk-ink-soft` (#5c5f66) had the
 * mirror problem: a mid-grey always finds a mid-tone in a photograph to vanish
 * into, and it measured 1.0:1 at *every* wash strength tested.
 *
 * So the tones here are near-opaque (80/70/90/85%), which restores the visual
 * hierarchy through weight rather than through transparency, and the plate
 * carries a measured 45% wash for the rest. Both halves were needed; neither
 * worked alone. The measured ratios are recorded in `apps/web/CLAUDE.md` — if
 * you change a tone here or the wash there, re-measure per text line, because
 * per element box flatters the numbers by including leading and ragged edges.
 *
 * The "Watch a run" button keeps the `quiet` tone rather than `ink`: two solid
 * heavy pills side by side compete, and the secondary should not be shouting.
 *
 * ## The block clears the table edge
 *
 * The tabletop starts at 72% of frame (`PLATE_DESK_EDGE_NDC`). Everything above
 * that is the blurred room and reads normally; the wood below carries the
 * paperwork and must stay clean, so nothing here is allowed to reach it. The
 * buttons are the lowest element and stop above the edge — unlike the previous
 * plate, they no longer sit *on* the desk, because this table is a working
 * surface with twenty documents on it rather than an empty band.
 *
 * ## The buttons are the lowest element, on purpose
 *
 * The proof facts used to sit beneath the calls to action, which made small
 * grey text the lowest thing on the screen — and text is what cannot survive
 * having paper behind it. Reserving space for it pushed the desk's documents
 * out of the entire lower centre and left a hole in the middle of the shot.
 * The buttons are opaque, so documents can come right up under them; the facts
 * moved above them and the room got its centre back.
 *
 * ## It scrolls away on its own
 *
 * There is no fade logic here. The copy is positioned in the first viewport of
 * the scene's tall scroll container while the canvas behind it is `sticky`, so
 * scrolling lifts the words off the top of the screen while the room stays. The
 * scene's own captions take over from `core-scene.tsx` once the documents start
 * to rise.
 */

const PROOF = [
  { icon: Lock, label: "Row-level tenant isolation" },
  { icon: ScrollText, label: "Append-only audit trail" },
  { icon: KeyRound, label: "Bring your own model key" },
] as const;

export function HeroCopy() {
  const router = useRouter();
  const lenis = useLenis();

  /**
   * "Watch a run" jumps to the run scene.
   *
   * `#how-it-works` is a zero-height marker inside the scene's 420vh scroll
   * container, positioned by `sceneAnchorTopVh` — it is a scroll POSITION, not
   * a section. Lenis owns the document scroll on this page
   * (`components/marketing/smooth-scroll.tsx`), and a native
   * `scrollIntoView({ behavior: "smooth" })` runs the browser's own animation
   * against it, so the two fight over the same position.
   *
   * `offset: 0` mirrors the explicit `scrollMarginTop: 0` on that marker: the
   * sticky stage fills the viewport, so aligning to the very top is exactly
   * right here. The fallback keeps the button working if the Lenis context is
   * ever absent — nothing on the page should depend on the smoothing existing.
   */
  const scrollToRun = () => {
    if (lenis) {
      lenis.scrollTo("#how-it-works", { offset: 0 });
      return;
    }
    document.getElementById("how-it-works")?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div className="mx-auto max-w-3xl px-5 text-center">
      <p className="mk-eyebrow text-mk-ink/80">Workflow automation for ERP, HR and Finance</p>

      <h1 className="mk-display mt-4 text-[2.75rem] text-mk-ink sm:text-6xl lg:text-[4.25rem]">
        <span className="block">Automation that knows</span>
        <span className="block text-mk-ink/70">when to ask</span>
      </h1>

      <p className="mx-auto mt-5 max-w-2xl text-[1.0625rem] leading-relaxed font-medium text-mk-ink/90 sm:text-[1.125rem]">
        Orkest runs your back-office workflows end to end — reading documents, calling your systems,
        closing the loop. Then it stops for a person before anything touches your ledger.
      </p>

      <ul className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2.5">
        {PROOF.map((item) => (
          <li
            key={item.label}
            className="flex items-center gap-1.5 text-[0.8125rem] text-mk-ink/85"
          >
            <item.icon className="size-3.5 text-mk-lime-deep" aria-hidden />
            {item.label}
          </li>
        ))}
      </ul>

      <div className="pointer-events-auto mt-7 flex flex-wrap items-center justify-center gap-3">
        <InteractiveHoverButton
          text="Start building"
          tone="solid"
          onClick={() => router.push("/register")}
        />
        <InteractiveHoverButton
          text="Watch a run"
          tone="quiet"
          onClick={() => scrollToRun()}
        />
      </div>
    </div>
  );
}
