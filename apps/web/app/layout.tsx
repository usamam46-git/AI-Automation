import type { Metadata } from "next";
import { Instrument_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { AppProviders } from "@/components/providers/app-providers";

/**
 * Display face for the marketing surface. Body copy stays on the system
 * SF/Segoe stack declared in `globals.css` — that stack IS the macOS feel the
 * product is modelled on, and swapping it for a webfont would make the app
 * chrome read as a generic SaaS dashboard.
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
      className={`h-full font-sans antialiased ${instrumentSans.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-full">
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
