import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { DotArc } from "@/components/ui/dot-arc";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * One of the four §5.1 stat cards.
 *
 * `accent` tints the icon tile only, never the figure — the numbers stay
 * `text-foreground` so the row reads as one scale rather than four competing
 * signals.
 *
 * Since the Atomie pass the palettes come from the `--color-status-*` tokens
 * rather than from hand-written Tailwind pairs with `dark:` twins. That set is
 * shared with `components/ui/badge.tsx` and `lib/node-catalog.ts`, so "amber
 * means something is waiting on you" is now literally the same colour value on
 * this page as in the timeline (Vol. 3 §5's "one status vocabulary everywhere")
 * instead of three copies that have to be kept in step by hand.
 *
 * `brand` is the fourth option and is NOT a status: it is the lime tile, for the
 * one card on the row that is a headline rather than a condition.
 */
export type StatAccent = "neutral" | "info" | "warning" | "success" | "brand";

const ACCENT_CLASS: Record<StatAccent, string> = {
  neutral: "bg-surface-2 text-muted-foreground",
  info: "bg-status-info-soft text-status-info",
  warning: "bg-status-warn-soft text-status-warn",
  success: "bg-status-ok-soft text-status-ok",
  brand: "",
};

export function StatCard({
  label,
  value,
  caption,
  icon: Icon,
  accent = "neutral",
  href,
  loading = false,
  arcValue,
}: {
  label: string;
  value: string;
  caption?: string;
  icon: LucideIcon;
  accent?: StatAccent;
  /** When set, the whole card becomes a link to the filtered list behind it. */
  href?: string;
  loading?: boolean;
  /**
   * 0..1 fraction. When present the card draws the dot arc behind the figure
   * instead of an icon tile. `null` renders the empty track, which is the
   * correct picture for "nothing has finished yet" — the same distinction
   * `formatSuccessRate` draws between null and 0.
   */
  arcValue?: number | null;
}) {
  const showArc = arcValue !== undefined;

  const body = (
    <Card className={cn("flex h-full flex-col gap-3 p-5 transition-colors", href && "hover:bg-surface-2")}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm text-muted-foreground">{label}</span>
        {/* The arc occupies the icon tile's slot rather than being absolutely
            positioned behind the figure. Bleeding it off the corner was tried
            first and the card's own `overflow-hidden` sliced it into an
            unreadable crescent — the mark has to be wholly inside the card to
            be a mark at all. */}
        {showArc ? (
          <DotArc value={arcValue} size={40} className="-mt-0.5 shrink-0" label={`${label} gauge`} />
        ) : (
          <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-xl", accent === "brand" ? "app-tile" : ACCENT_CLASS[accent])}>
            <Icon className="size-4" />
          </span>
        )}
      </div>

      {loading ? (
        <Skeleton className="h-8 w-20" />
      ) : (
        <span className="text-3xl font-semibold tabular-nums leading-none tracking-tight">{value}</span>
      )}

      {/* Reserved even while loading so the card doesn't change height when the
          figure lands and shove the Recent Executions list down the page. */}
      <span className="min-h-4 text-xs text-muted-foreground">
        {loading ? <Skeleton className="h-3 w-28" /> : caption}
      </span>
    </Card>
  );

  return href ? (
    <Link href={href} className="rounded-2xl focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30">
      {body}
    </Link>
  ) : (
    body
  );
}
