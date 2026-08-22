import { OrkestMark } from "@/components/marketing/orkest-mark";

/**
 * The signed-out surface.
 *
 * Same Atomie scope as the dashboard (`app-root`), and the bloom sits on its own
 * fixed inert layer behind the card. This is where the language reads most
 * clearly — there is no data on screen to compete with it — so it is also the
 * first impression of the product for anyone arriving from the landing page.
 *
 * The mark is imported from `components/marketing/` rather than copied. It is
 * plain `currentColor` SVG with no marketing tokens in it, and a second copy
 * would be a second thing to keep in step with `MARK_NODES` in the 3D scene.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-root relative flex min-h-screen flex-col items-center justify-center bg-background p-4">
      <div className="app-bloom" aria-hidden />
      <div className="relative z-10 flex w-full flex-col items-center gap-6">
        <div className="flex items-center gap-2 text-foreground">
          <OrkestMark className="size-6" />
          <span className="text-base font-semibold tracking-tight">Orkest</span>
        </div>
        {children}
      </div>
    </div>
  );
}
