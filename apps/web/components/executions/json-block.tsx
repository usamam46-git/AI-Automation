import { cn } from "@/lib/utils";

/**
 * Monospace JSON viewer for node input/output snapshots (Vol. 3 §3 specifies a
 * monospace face for node config/JSON views).
 *
 * Scrolls inside its own box — these payloads are arbitrary user data and a
 * long one must never widen the page.
 */
export function JsonBlock({ value, emptyLabel = "None", className }: { value: unknown; emptyLabel?: string; className?: string }) {
  if (value == null || (typeof value === "object" && Object.keys(value as object).length === 0)) {
    return <p className={cn("text-sm text-muted-foreground", className)}>{emptyLabel}</p>;
  }
  return (
    <pre className={cn("max-h-80 min-w-0 overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed", className)}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
