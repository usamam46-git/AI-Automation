"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { type Workflow } from "@/lib/api";

export function WorkflowDetailDialog({ workflow, open, onOpenChange, workspaceName }: { workflow: Workflow | null; open: boolean; onOpenChange: (open: boolean) => void; workspaceName?: string }) {
  const router = useRouter();
  if (!workflow) return null;

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
          <div className="flex items-center justify-between"><span className="text-muted-foreground">Created</span><span>{new Date(workflow.created_at).toLocaleString()}</span></div>
          <div className="flex items-center justify-between"><span className="text-muted-foreground">Version</span><span>{workflow.current_version_id ?? "Not compiled"}</span></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => router.push(`/workflows/${workflow.id}/builder`)}>Open Builder</Button>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
