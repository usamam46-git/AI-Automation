"use client";

import { useRouter } from "next/navigation";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { WebhookSecretCard } from "@/components/workflows/webhook-secret-card";
import { type Workflow } from "@/lib/api";

/**
 * `onRun` hands the workflow back to the page, which owns the single
 * `RunWorkflowDialog`. This dialog closes first rather than opening the run
 * dialog inside itself — two stacked Radix dialogs fight over focus trapping
 * and the payload textarea ends up unfocusable.
 */
export function WorkflowDetailDialog({
  workflow,
  open,
  onOpenChange,
  workspaceName,
  onRun,
}: {
  workflow: Workflow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceName?: string;
  onRun: (workflow: Workflow) => void;
}) {
  const router = useRouter();
  if (!workflow) return null;

  const canRun = Boolean(workflow.current_version_id);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{workflow.name}</DialogTitle>
          <DialogDescription>{workflow.description || "No description provided."}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 text-sm">
          <div className="flex items-center justify-between"><span className="text-muted-foreground">Status</span><Badge variant={workflow.status}>{workflow.status}</Badge></div>
          <div className="flex items-center justify-between"><span className="text-muted-foreground">Workspace</span><span>{workspaceName ?? workflow.workspace_id.slice(0, 8)}</span></div>
          <div className="flex items-center justify-between"><span className="text-muted-foreground">Trigger</span><span className="capitalize">{workflow.trigger_type}</span></div>
          {workflow.trigger_type === "schedule" ? (
            <>
              <div className="flex items-center justify-between"><span className="text-muted-foreground">Schedule</span><span className="font-mono text-xs">{String(workflow.trigger_config?.cron ?? "—")}</span></div>
              {/*
                A schedule only fires once the workflow is published — the beat
                tick filters on status='published' AND current_version_id. Saying
                "Next run" for a draft would promise a run that never comes.
              */}
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Next run</span>
                <span>{canRun ? (workflow.next_run_at ? new Date(workflow.next_run_at).toLocaleString() : "—") : "Not until published"}</span>
              </div>
            </>
          ) : null}
          {workflow.last_triggered_at ? (
            <div className="flex items-center justify-between"><span className="text-muted-foreground">Last triggered</span><span>{new Date(workflow.last_triggered_at).toLocaleString()}</span></div>
          ) : null}
          <div className="flex items-center justify-between"><span className="text-muted-foreground">Created</span><span>{new Date(workflow.created_at).toLocaleString()}</span></div>
          <div className="flex items-center justify-between"><span className="text-muted-foreground">Version</span><span>{workflow.current_version_number != null ? `v${workflow.current_version_number}` : "Not compiled"}</span></div>
          {workflow.trigger_type === "webhook" ? <WebhookSecretCard workflow={workflow} /> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => router.push(`/workflows/${workflow.id}/builder`)}>Open Builder</Button>
          {canRun ? (
            <Button
              onClick={() => {
                onOpenChange(false);
                onRun(workflow);
              }}
            >
              <Play className="size-4" />Run now
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild><span tabIndex={0}><Button disabled><Play className="size-4" />Run now</Button></span></TooltipTrigger>
              <TooltipContent>Publish a version before running this workflow.</TooltipContent>
            </Tooltip>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
