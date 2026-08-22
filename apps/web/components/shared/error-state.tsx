import { TriangleAlert } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/**
 * The retry-capable error card.
 *
 * The tile is the `bad` status colour rather than the lime one an EmptyState
 * uses — this is the one shared state that is genuinely reporting a failure,
 * and the status vocabulary is where "something went wrong" is spoken. Lime
 * here would say "brand" on a card whose whole job is to say "problem".
 */
export function ErrorState({ title = "Something went wrong", message, onRetry }: { title?: string; message: string; onRetry?: () => void }) {
  return (
    <Card className="flex flex-col items-center justify-center gap-4 p-8 text-center">
      <span className="flex size-11 items-center justify-center rounded-xl bg-status-bad-soft text-status-bad">
        <TriangleAlert className="size-5" />
      </span>
      <div>
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">{message}</p>
      </div>
      {onRetry ? <Button variant="outline" onClick={onRetry}>Retry</Button> : null}
    </Card>
  );
}
