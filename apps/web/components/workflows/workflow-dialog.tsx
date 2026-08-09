"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { type TriggerType, workflowsApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";

// Only the three trigger types with a dispatch path behind them. `email` (needs
// the Vol. 2 §646 Gmail/Microsoft OAuth grant) and `event` (needs an event-bus
// binding) remain in the TriggerType union because the DB and API still know
// those values — but the backend rejects them with a 422 as of 2026-08-09
// (IMPLEMENTED_TRIGGER_TYPES in modules/workflows/service.py), so offering them
// here would only produce a create dialog that fails on submit. Before
// 2026-08-09 they were offered AND accepted, and the workflow silently never
// fired. Keep this list in sync with IMPLEMENTED_TRIGGER_TYPES.
const triggerTypes: TriggerType[] = ["manual", "schedule", "webhook"];

const triggerHelp: Record<string, string> = {
  manual: "Runs only when someone clicks Run now.",
  schedule: "Runs on a cron schedule, once the workflow is published.",
  webhook: "Runs when a signed HTTP request arrives. Generate a signing secret from the workflow's details after creating.",
};

function WorkflowDialogForm({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const orgId = useAuthStore((state) => state.orgId);
  const workspaceId = useAppStore((state) => state.currentWorkspaceId);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [triggerType, setTriggerType] = React.useState<TriggerType>("manual");
  const [cron, setCron] = React.useState("0 9 * * 1-5");

  // A `schedule` workflow with no cron is rejected by the API (422), so the
  // expression has to be collected here rather than left for a later edit.
  // Everything else sends null — `webhook` keeps its secret in a dedicated
  // column, never in trigger_config.
  const triggerConfig = triggerType === "schedule" ? { cron: cron.trim() } : null;

  const mutation = useMutation({
    mutationFn: () => workflowsApi.create({ name: name.trim(), description: description.trim() || null, workspace_id: workspaceId!, trigger_type: triggerType, trigger_config: triggerConfig }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["workflows", orgId] });
      toast.success("Workflow created");
      onOpenChange(false);
    },
    onError: (error) => toast.error(getApiErrorMessage(error, "Could not create workflow")),
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>New workflow</DialogTitle>
        <DialogDescription>Create a metadata-only workflow shell for the current workspace.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-3">
        <div className="grid gap-1.5"><Label htmlFor="workflow-name">Name</Label><Input id="workflow-name" value={name} onChange={(event) => setName(event.target.value)} autoFocus />{name.length > 0 && !name.trim() ? <p className="text-xs text-destructive">Enter a workflow name.</p> : null}</div>
        <div className="grid gap-1.5"><Label htmlFor="workflow-description">Description</Label><Textarea id="workflow-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Optional" /></div>
        <div className="grid gap-1.5"><Label>Trigger type</Label><Select value={triggerType} onValueChange={(value) => setTriggerType(value as TriggerType)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{triggerTypes.map((type) => <SelectItem key={type} value={type} className="capitalize">{type}</SelectItem>)}</SelectContent></Select><p className="text-xs text-muted-foreground">{triggerHelp[triggerType]}</p></div>
        {triggerType === "schedule" ? (
          <div className="grid gap-1.5">
            <Label htmlFor="workflow-cron">Cron expression</Label>
            <Input id="workflow-cron" value={cron} onChange={(event) => setCron(event.target.value)} placeholder="0 9 * * 1-5" className="font-mono" />
            <p className="text-xs text-muted-foreground">Five fields, evaluated in UTC. Must not fire more than once a minute.</p>
          </div>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button disabled={!name.trim() || !workspaceId || (triggerType === "schedule" && !cron.trim()) || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}Create</Button>
      </DialogFooter>
    </>
  );
}

export function WorkflowDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>{open ? <WorkflowDialogForm key="new-workflow" onOpenChange={onOpenChange} /> : null}</DialogContent>
    </Dialog>
  );
}
