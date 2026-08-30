import type { Metadata } from "next";

import { MkNav } from "@/components/marketing/mk-nav";
import { MkFooter } from "@/components/marketing/mk-footer";
import { SmoothScroll } from "@/components/marketing/smooth-scroll";

export const metadata: Metadata = {
  title: "Orkest AI — Automation that knows when to ask",
  description:
    "Orkest runs your back-office workflows end to end — reading documents, calling your systems, closing the loop. Then it stops for a person before anything touches your ledger.",
};

/**
 * Marketing route group.
 *
 * `mk-root` locks this subtree to the light palette (see `globals.css`).
 * `next-themes` puts `.dark` on <html>, and the hero's sky gradient, near-white
 * body and lime CTA are a single committed light design — rendering them
 * against the app's true-black tokens would not be a dark variant, it would be
 * a broken page. Every shadcn primitive used below (Button, Select, Switch,
 * Accordion) reads its colours from the tokens `mk-root` redefines, so they
 * come out light too without a per-component override.
 *
 * The app routes are unaffected and keep both themes.
 *
 * `SmoothScroll` scopes Lenis to this subtree for the same reason. The product
 * behind the login has inner scrollers of its own — the shell's `main`, the
 * ScrollArea primitive, the React Flow builder canvas — and taking over the
 * document scroll there is all risk and no benefit. The landing page is the
 * only surface here whose centrepiece is a scroll scrub.
 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mk-root min-h-screen bg-mk-paper text-mk-ink">
      <SmoothScroll>
        <a
          href="#main"
          className="sr-only rounded-full bg-mk-ink px-4 py-2 text-sm font-semibold text-white focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[60]"
        >
          Skip to content
        </a>
        <MkNav />
        <main id="main">{children}</main>
        <MkFooter />
      </SmoothScroll>
    </div>
  );
}
