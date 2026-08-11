"use client";

import * as React from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { OrkestMark } from "@/components/marketing/orkest-mark";

const LINKS = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#platform", label: "Platform" },
  { href: "#pricing", label: "Pricing" },
  { href: "#faq", label: "FAQ" },
] as const;

/**
 * Floating macOS-style nav pill.
 *
 * It starts transparent over the sky and picks up a light glass fill once the
 * hero has scrolled past, because the same white-on-glass treatment that reads
 * as crisp against deep blue becomes invisible against the near-white page
 * body. The swap is a class change on a scroll listener rather than a
 * ScrollTrigger — it needs no scrub and no pin, and a passive listener is
 * considerably cheaper than a trigger instance.
 */
export function MkNav() {
  const [scrolled, setScrolled] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 72);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // A fixed-position menu that survives a scroll is disorienting; close it.
  React.useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, { passive: true });
    return () => window.removeEventListener("scroll", close);
  }, [open]);

  return (
    <header className="fixed inset-x-0 top-0 z-50 px-4 pt-3 sm:pt-4">
      <nav
        className={cn(
          "mx-auto flex max-w-5xl items-center justify-between gap-4 rounded-full py-2 pl-4 pr-2 transition-all duration-300 ease-out sm:pl-5",
          // `/95` rather than a lighter glass: the pill turns solid while still
          // travelling over the blue hero, and at `/80` the sky bled through
          // enough to drop the muted nav links below readable contrast.
          scrolled
            ? "border border-[var(--mk-hairline)] bg-white/95 shadow-[0_1px_2px_rgba(20,20,20,0.04),0_8px_24px_-8px_rgba(20,20,20,0.10)] backdrop-blur-xl backdrop-saturate-150"
            : "border border-transparent bg-transparent",
        )}
      >
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2 rounded-full outline-none focus-visible:ring-3 focus-visible:ring-mk-sky/50"
        >
          <OrkestMark className={cn("size-6 transition-colors", scrolled ? "text-mk-ink" : "text-white")} />
          <span
            className={cn(
              "font-[family-name:var(--font-display)] text-[0.9375rem] font-semibold tracking-tight transition-colors",
              scrolled ? "text-mk-ink" : "text-white",
            )}
          >
            Orkest
          </span>
        </Link>

        <div className="hidden items-center gap-1 md:flex">
          {LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className={cn(
                "rounded-full px-3 py-1.5 text-[0.8125rem] font-medium tracking-tight transition-colors outline-none focus-visible:ring-3 focus-visible:ring-mk-sky/50",
                scrolled
                  ? "text-mk-ink-soft hover:bg-mk-mist hover:text-mk-ink"
                  : "text-white/80 hover:bg-white/15 hover:text-white",
              )}
            >
              {link.label}
            </a>
          ))}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Link
            href="/login"
            className={cn(
              "hidden rounded-full px-3.5 py-2 text-[0.8125rem] font-medium tracking-tight transition-colors outline-none focus-visible:ring-3 focus-visible:ring-mk-sky/50 sm:block",
              scrolled ? "text-mk-ink hover:bg-mk-mist" : "text-white hover:bg-white/15",
            )}
          >
            Sign in
          </Link>
          <Link
            href="/register"
            className="rounded-full bg-mk-lime px-4 py-2 text-[0.8125rem] font-semibold tracking-tight text-mk-ink transition-colors outline-none hover:bg-mk-lime-deep focus-visible:ring-3 focus-visible:ring-mk-lime/60"
          >
            Start free
          </Link>
          <button
            type="button"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className={cn(
              "flex size-9 items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-3 focus-visible:ring-mk-sky/50 md:hidden",
              scrolled ? "text-mk-ink hover:bg-mk-mist" : "text-white hover:bg-white/15",
            )}
          >
            {open ? <X className="size-5" aria-hidden /> : <Menu className="size-5" aria-hidden />}
          </button>
        </div>
      </nav>

      {open ? (
        <div className="mx-auto mt-2 max-w-5xl overflow-hidden rounded-2xl border border-[var(--mk-hairline)] bg-white/90 p-2 shadow-[0_12px_32px_-8px_rgba(20,20,20,0.14)] backdrop-blur-xl md:hidden">
          {LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className="block rounded-xl px-3 py-2.5 text-[0.9375rem] font-medium text-mk-ink hover:bg-mk-mist"
            >
              {link.label}
            </a>
          ))}
          <Link
            href="/login"
            className="block rounded-xl px-3 py-2.5 text-[0.9375rem] font-medium text-mk-ink hover:bg-mk-mist sm:hidden"
          >
            Sign in
          </Link>
        </div>
      ) : null}
    </header>
  );
}
