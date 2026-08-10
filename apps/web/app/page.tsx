import { redirect } from "next/navigation";

/**
 * Placeholder root. Vol. 3 §1.1 gives `/` to `(marketing)/page.tsx` — the
 * public landing page — which does not exist yet. Until it does, `/` bounces
 * into the app.
 *
 * The dashboard home lives at `/dashboard`, not here: a `(dashboard)/page.tsx`
 * would also resolve to `/` and Next.js errors on two route groups claiming the
 * same path. When the marketing landing lands, this file is the one it replaces.
 */
export default function Home() {
  redirect("/dashboard");
}
