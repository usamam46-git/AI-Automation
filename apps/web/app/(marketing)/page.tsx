import { SystemMarquee } from "@/components/marketing/system-marquee";
import { Contact } from "@/components/marketing/contact";
import { Faq } from "@/components/marketing/faq";
import { Hero } from "@/components/marketing/hero";
import { PlatformTiles } from "@/components/marketing/platform-tiles";
import { Pricing } from "@/components/marketing/pricing";
import { RunFilm } from "@/components/marketing/run-film";
import { Statement } from "@/components/marketing/statement";

/**
 * The public landing page, at `/`.
 *
 * Order is an argument, not a checklist: the hero makes the claim, the film
 * proves it by showing a run stop at the approval gate, the statement explains
 * why that is a deliberate constraint, and only then does the page talk about
 * the platform underneath and what it costs.
 */
export default function LandingPage() {
  return (
    <>
      <Hero />
      <SystemMarquee />
      <RunFilm />
      <Statement />
      <PlatformTiles />
      <Pricing />
      <Faq />
      <Contact />
    </>
  );
}
