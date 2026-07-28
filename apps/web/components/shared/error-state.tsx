import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export function ErrorState({ title = "Something went wrong", message, onRetry }: { title?: string; message: string; onRetry?: () => void }) {
  return (
    <Card className="flex flex-col items-center justify-center gap-3 p-6 text-center">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      </div>
      {onRetry ? <Button variant="outline" onClick={onRetry}>Retry</Button> : null}
    </Card>
  );
}
