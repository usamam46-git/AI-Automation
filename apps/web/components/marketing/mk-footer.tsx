"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { InteractiveHoverButton } from "@/components/ui/interactive-hover-button";
import { OrkestMark } from "@/components/marketing/orkest-mark";

const COLUMNS = [
  {
    heading: "Product",
    links: [
      { label: "How it works", href: "#how-it-works" },
      { label: "Platform", href: "#platform" },
      { label: "Pricing", href: "#pricing" },
      { label: "FAQ", href: "#faq" },
    ],
  },
  {
    heading: "Company",
    links: [
      { label: "Talk to us", href: "#contact" },
      { label: "Sign in", href: "/login" },
      { label: "Create an account", href: "/register" },
    ],
  },
] as const;

export function MkFooter() {
  const router = useRouter();

  return (
    <footer className="bg-mk-ink px-5 pt-20 pb-10 text-white">
      <div className="mx-auto max-w-6xl">
        {/* Closing CTA. Reuses the hero's button so the page opens and shuts on
            the same gesture. */}
        <div className="border-b border-white/10 pb-16 text-center">
          <h2 className="mk-display mx-auto max-w-2xl text-[2rem] sm:text-[3rem]">
            Start with one workflow you already dread
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-[1.0625rem] leading-relaxed text-white/60">
            Free while you build. You only pay once it is running for real.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <InteractiveHoverButton
              text="Start building"
              tone="lime"
              onClick={() => router.push("/register")}
            />
            <a
              href="#contact"
              className="rounded-full border border-white/20 px-6 py-3 text-[0.9375rem] font-semibold tracking-tight text-white transition-colors outline-none hover:bg-white/10 focus-visible:ring-3 focus-visible:ring-white/40"
            >
              Talk to us first
            </a>
          </div>
        </div>

        <div className="grid gap-10 py-14 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <Link href="/" className="inline-flex items-center gap-2">
              <OrkestMark className="size-6 text-white" />
              <span className="font-[family-name:var(--font-display)] text-[1rem] font-semibold tracking-tight">
                Orkest
              </span>
            </Link>
            <p className="mt-4 max-w-xs text-[0.875rem] leading-relaxed text-white/50">
              Workflow automation for the back office, built so the parts that matter still pass
              through a person.
            </p>
          </div>

          {COLUMNS.map((column) => (
            <nav key={column.heading} aria-label={column.heading}>
              <h3 className="mk-eyebrow text-white/40">{column.heading}</h3>
              <ul className="mt-4 flex flex-col gap-2.5">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="rounded text-[0.875rem] text-white/70 transition-colors outline-none hover:text-white focus-visible:ring-3 focus-visible:ring-white/40"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="flex flex-col gap-3 border-t border-white/10 pt-8 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[0.8125rem] text-white/40">
            © {new Date().getFullYear()} Orkest AI. All rights reserved.
          </p>
          <p className="font-[family-name:var(--font-jetbrains-mono)] text-[11px] text-white/30">
            built for the work that can&apos;t be wrong
          </p>
        </div>
      </div>
    </footer>
  );
}
