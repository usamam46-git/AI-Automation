import { Button } from "@/components/ui/button";

export function EmptyState({ title, message, actionLabel, onAction }: { title: string; message: string; actionLabel: string; onAction: () => void }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 p-6 text-center">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{message}</p>
      <Button className="mt-4" onClick={onAction}>{actionLabel}</Button>
    </div>
  );
}
