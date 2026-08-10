import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * One of the four §5.1 stat cards.
 *
 * `accent` tints the icon only, never the figure — the numbers stay
 * `text-foreground` so the row reads as one scale rather than four competing
 * signals.
 *
 * The palettes deliberately mirror components/ui/badge.tsx's run-status
 * variants (sky = running, amber = waiting, emerald = completed), so "amber
 * means something is waiting on you" carries the same meaning on this page as
 * it does in the timeline — Vol. 3 §5's "one status vocabulary everywhere".
 * They are written as Tailwind palette classes rather than `--color-status-*`
 * tokens because that token set does not exist: badge.tsx's cva IS where the
 * vocabulary lives. Each needs its own dark variant for the same reason.
 */
export type StatAccent = "neutral" | "info" | "warning" | "success";

const ACCENT_CLASS: Record<StatAccent, string> = {
  neutral: "bg-muted text-muted-foreground",
  info: "bg-sky-50 text-sky-700 dark:bg-sky-400/10 dark:text-sky-300",
  warning: "bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300",
  success: "bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300",
};

export function StatCard({
  label,
  value,
  caption,
  icon: Icon,
  accent = "neutral",
  href,
  loading = false,
}: {
  label: string;
  value: string;
  caption?: string;
  icon: LucideIcon;
  accent?: StatAccent;
  /** When set, the whole card becomes a link to the filtered list behind it. */
  href?: string;
  loading?: boolean;
}) {
  const body = (
    <Card
      className={cn(
        "flex h-full flex-col gap-3 p-4 transition-colors",
        href && "hover:border-ring/40 hover:bg-muted/30"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg", ACCENT_CLASS[accent])}>
          <Icon className="size-4" />
        </span>
      </div>

      {loading ? (
        <Skeleton className="h-8 w-20" />
      ) : (
        <span className="text-2xl font-semibold tabular-nums leading-none">{value}</span>
      )}

      {/* Reserved even while loading so the card doesn't change height when the
          figure lands and shove the Recent Executions list down the page. */}
      <span className="min-h-4 text-xs text-muted-foreground">
        {loading ? <Skeleton className="h-3 w-28" /> : caption}
      </span>
    </Card>
  );

  return href ? (
    <Link href={href} className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {body}
    </Link>
  ) : (
    body
  );
}
