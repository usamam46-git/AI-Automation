import Image from "next/image";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";

import { OrkestMark } from "@/components/marketing/orkest-mark";

/**
 * The signed-out surface — a two-column split, form left, photograph right.
 *
 * It used to be a single centred card on the app background. That read as a
 * scaffold: the marketing page opens on a photographed room and sells hard, and
 * the first thing anyone saw after clicking "Get started" was an unadorned box.
 * The split keeps the form exactly as prominent while giving the page something
 * to be, and it is the same move the landing page already makes — a real
 * photograph carrying the mood, product geometry drawn on top of it.
 *
 * Three things about the right-hand panel are deliberate:
 *
 * - **It is its own dark surface in BOTH themes.** The scrim is opaque enough to
 *   fix the type contrast independently of the viewer's theme, so there is no
 *   `dark:` variant to keep in step and no light-mode combination where white
 *   type lands on a bright patch of glass.
 *
 *   Measured on the composited panel (photo → `neutral-950/55` wash → the
 *   gradient), worst pixel per line at 1470×776, each line's own text alpha
 *   applied — NOT pure white, which flatters every translucent line:
 *
 *   | Line | Ratio | Needs |
 *   |---|---|---|
 *   | Chip, 12px (over its own `white/10` fill) | 8.26:1 | 4.5 |
 *   | Headline, 28px semibold | 12.45:1 | 3.0 (large) |
 *   | Subhead, 14px `white/70` | 8.56:1 | 4.5 |
 *   | Credit, 11px `white/55` | 6.09:1 | 4.5 |
 *
 *   **The credit is the one that failed.** At `white/40` it measured **3.82:1**
 *   — the translucent-ink ceiling already documented for the marketing hero, and
 *   the reason to measure rather than eyeball: it looks like a deliberately quiet
 *   caption at either value. `/55` is the first step that clears AA (`/50` gives
 *   5.25:1, but leaves no margin if the plate is ever swapped). If you change the
 *   photograph or either scrim, re-measure — the method is a canvas composite of
 *   the same layers, sampling the worst pixel under each line's box.
 * - **It is `hidden lg:block`.** Below 1024px it is not shrunk, it is dropped —
 *   a 40%-width photograph beside a form is decoration competing with the only
 *   thing on the page that does something. The form column then centres itself.
 * - **The claim on it is the product's actual guarantee**, the one
 *   `validate_mutating_approval` enforces at publish time. It is not a slogan
 *   about AI; a visitor who reads it and then uses the product finds the same
 *   sentence being true.
 *
 * Eager + high fetch priority, NOT `priority` — that prop is deprecated in Next
 * 16 (see `next/dist/docs/01-app/03-api-reference/02-components/image.md`, which
 * points at `loading="eager"` / `fetchPriority="high"` for exactly this case).
 * It earns it here and would not elsewhere: on a two-element page this IS the LCP
 * candidate on any desktop viewport, and there is nothing below the fold for it
 * to steal bandwidth from. Below `lg` the element is not rendered at all, so a
 * phone never pays for it.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-root grid min-h-screen bg-background lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="relative flex flex-col px-6 py-8 sm:px-10">
        <div className="app-bloom" aria-hidden />

        <header className="relative z-10">
          <Link href="/" className="inline-flex items-center gap-2 text-foreground transition-opacity hover:opacity-80">
            <OrkestMark className="size-6" />
            <span className="text-base font-semibold tracking-tight">Orkest</span>
          </Link>
        </header>

        <main className="relative z-10 flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-[400px]">{children}</div>
        </main>

        <footer className="relative z-10 text-xs text-muted-foreground">
          Human approval required on every mutating action.
        </footer>
      </div>

      <aside className="relative hidden overflow-hidden lg:block">
        <Image
          src="https://images.unsplash.com/photo-1497366754035-f200968a6e72?w=1600&q=80&auto=format&fit=crop"
          alt=""
          fill
          loading="eager"
          fetchPriority="high"
          sizes="(min-width: 1024px) 52vw, 0px"
          className="object-cover"
        />
        {/* Two layers, not one: a flat wash fixes the floor of the contrast ratio
            over the bright glass, and the gradient darkens the bottom third where
            the type actually sits. A single gradient left the top-left corner of
            the eyebrow row sitting at ~3:1 over the corridor's lit ceiling. */}
        <div className="absolute inset-0 bg-neutral-950/55" aria-hidden />
        <div className="absolute inset-0 bg-gradient-to-t from-neutral-950/90 via-neutral-950/35 to-neutral-950/25" aria-hidden />

        <div className="relative flex h-full flex-col justify-end p-12">
          <div className="mb-5 inline-flex w-fit items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-sm ring-1 ring-inset ring-white/20">
            <ShieldCheck className="size-3.5" aria-hidden />
            Approval gate enforced at publish
          </div>

          <p className="max-w-[26rem] text-[1.75rem] font-semibold leading-[1.25] tracking-tight text-white">
            A workflow that writes to your ledger cannot go live without a human in front of it.
          </p>

          <p className="mt-4 max-w-[26rem] text-sm leading-relaxed text-white/70">
            Journal entries, payments and ERP writes are checked at publish time, not left to a prompt. Publishing without an
            upstream approval node fails, and the error names the node.
          </p>

          {/* Unsplash's licence does not require attribution, but crediting the
              photographer by name is the decent version of it. The name is NOT
              filled in because it could not be verified: unsplash.com sits behind
              a bot wall that returns 401 to any automated fetch, and inventing a
              plausible-looking name under a photograph is worse than a generic
              credit. Replace this with the photographer's name and their photo
              URL — the source id is `photo-1497366754035-f200968a6e72`. */}
          <p className="mt-10 text-[11px] text-white/55">
            Photograph via{" "}
            <a
              href="https://unsplash.com"
              className="underline underline-offset-2 transition-colors hover:text-white"
              target="_blank"
              rel="noreferrer noopener"
            >
              Unsplash
            </a>
          </p>
        </div>
      </aside>
    </div>
  );
}
