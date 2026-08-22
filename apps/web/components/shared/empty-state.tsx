import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/**
 * The calm centred empty state every list page renders (see the scope rule in
 * apps/web/CLAUDE.md — loading / empty / error are not optional polish).
 *
 * It used to be a dashed outline over a tinted panel. The Atomie language draws
 * surfaces as fills rather than as strokes, and a dashed border is the loudest
 * stroke there is — an empty list ended up being the busiest thing on the page.
 * It is now a plain card with a lime tile, which is the same treatment a
 * populated card gets, so an empty page reads as quiet rather than as broken.
 */
export function EmptyState({
  title,
  message,
  actionLabel,
  onAction,
  icon: Icon,
}: {
  title: string;
  message: string;
  actionLabel: string;
  onAction: () => void;
  /** Optional glyph for the lime tile. Omitted renders the tile-less variant. */
  icon?: LucideIcon;
}) {
  return (
    <Card className="flex min-h-64 flex-col items-center justify-center p-8 text-center">
      {Icon ? (
        <span className="app-tile mb-4 size-11">
          <Icon className="size-5" />
        </span>
      ) : null}
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">{message}</p>
      <Button className="mt-5" onClick={onAction}>
        {actionLabel}
      </Button>
    </Card>
  );
}
