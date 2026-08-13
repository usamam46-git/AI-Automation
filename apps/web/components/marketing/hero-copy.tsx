"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
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
 * ## It is ink on paper now, not white on sky
 *
 * The old copy was white with a text-shadow, and every contrast decision on it
 * was tuned against a blue gradient — that whole contract is void here. On the
 * room's near-white wall the text is `--mk-ink` (#141414), which is 16:1 and
 * needs no shadow, no scrim and no envelope. The "Watch a run" button loses its
 * glass tone for the same reason — a frosted button needs something behind it
 * to frost. It takes the `quiet` tone rather than `ink`: a solid black pill
 * beside a lime one made two heavy buttons competing on a walnut desk, and the
 * secondary should not be shouting.
 *
 * ## The block is tight because the desk edge is a hard line
 *
 * The wood starts a little over half way down the frame. Everything above that
 * line is on a light grey wall and reads normally; anything below it is grey
 * text on dark walnut and is simply unreadable. So the copy is spaced to keep
 * its **last line of text** above the desk edge — the buttons are allowed to
 * cross it because they are opaque.
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

  return (
    <div className="mx-auto max-w-3xl px-5 text-center">
      <p className="mk-eyebrow text-mk-ink/50">Workflow automation for ERP, HR and Finance</p>

      <h1 className="mk-display mt-4 text-[2.75rem] text-mk-ink sm:text-6xl lg:text-[4.25rem]">
        <span className="block">Automation that knows</span>
        <span className="block text-mk-ink/45">when to ask</span>
      </h1>

      <p className="mx-auto mt-5 max-w-2xl text-[1.0625rem] leading-relaxed font-medium text-mk-ink-soft sm:text-[1.125rem]">
        Orkest runs your back-office workflows end to end — reading documents, calling your systems,
        closing the loop. Then it stops for a person before anything touches your ledger.
      </p>

      <ul className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2.5">
        {PROOF.map((item) => (
          <li
            key={item.label}
            className="flex items-center gap-1.5 text-[0.8125rem] text-mk-ink-soft"
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
          onClick={() =>
            document.getElementById("how-it-works")?.scrollIntoView({ behavior: "smooth" })
          }
        />
      </div>
    </div>
  );
}
