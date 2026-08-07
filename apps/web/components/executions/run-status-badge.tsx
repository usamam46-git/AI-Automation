import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { runStatusMeta } from "@/lib/run-status";
import type { WorkflowRunStatus } from "@/lib/api";

/**
 * The one way a run's status is rendered, anywhere. Variants live in
 * components/ui/badge.tsx alongside the workflow-shell statuses so the product
 * keeps a single status vocabulary (Vol. 3 §5).
 */
export function RunStatusBadge({ status, className }: { status: WorkflowRunStatus; className?: string }) {
  const meta = runStatusMeta(status);
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant} className={cn("gap-1", className)}>
      <Icon className={cn("size-3", status === "running" && "animate-spin")} />
      {meta.label}
    </Badge>
  );
}
