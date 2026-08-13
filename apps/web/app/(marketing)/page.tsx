import { SystemMarquee } from "@/components/marketing/system-marquee";
import { Contact } from "@/components/marketing/contact";
import { Faq } from "@/components/marketing/faq";
import { PlatformTiles } from "@/components/marketing/platform-tiles";
import { Pricing } from "@/components/marketing/pricing";
import { CoreSceneSection } from "@/components/marketing/scene/core-scene-section";
import { Statement } from "@/components/marketing/statement";

/**
 * The public landing page, at `/`.
 *
 * Order is an argument, not a checklist: the page **opens in the office** — a
 * desk with this company's paperwork on it — and the same scene that carries
 * the hero copy then walks one real run into the approval gate and holds there,
 * the statement explains why that is a deliberate constraint, and only then does
 * the page talk about the platform underneath and what it costs.
 *
 * The scene replaced both the sky-gradient hero and `run-film.tsx`. The hero's
 * words live on in `hero-copy.tsx`, over the room; `hero.tsx`,
 * `sky-backdrop.tsx`, `aurora-canvas.tsx` and `hero-collage.tsx` are deleted. **`lib/run-film.ts` was kept** — its beat list is the script the
 * 3D run scene plays, so the tested invariant that `post_to_erp` is still
 * `pending` while `approval_1` waits now drives what you can see on screen.
 */
export default function LandingPage() {
  return (
    <>
      <CoreSceneSection />
      <SystemMarquee />
      <Statement />
      <PlatformTiles />
      <Pricing />
      <Faq />
      <Contact />
    </>
  );
}
