import type { Metadata } from "next";
import { Instrument_Sans, JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import { AppProviders } from "@/components/providers/app-providers";

/**
 * UI face for the product behind the login (2026-08-22, the Atomie pass).
 *
 * Scoped, not global: `globals.css`'s `.app-root` rebinds `--font-sans` to this
 * for `app/(dashboard)/` and `app/(auth)/` only, so marketing body copy keeps
 * the system stack it was designed and contrast-measured against.
 *
 * Plus Jakarta Sans over Poppins — the reference's face is a pure geometric,
 * which is exactly what falls apart at the 11-13px this app spends most of its
 * pixels on. Jakarta reads geometric at heading sizes and stays a real UI face
 * at label sizes.
 */
const plusJakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-jakarta",
  display: "swap",
});

/**
 * Display face for the marketing surface.
 */
const instrumentSans = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument-sans",
  display: "swap",
});

/**
 * Utility/data face. Used for the product's own vernacular — node keys, cron
 * expressions, run ids, HMAC algorithm names — wherever a literal is quoted.
 */
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Orkest AI — Automation that knows when to ask",
    template: "%s · Orkest AI",
  },
  description:
    "Orkest runs your back-office workflows end to end, and stops for a human before anything touches your ledger.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`h-full font-sans antialiased ${instrumentSans.variable} ${jetbrainsMono.variable} ${plusJakarta.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-full">
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
