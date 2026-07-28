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

const triggerTypes: TriggerType[] = ["manual", "schedule", "webhook", "email", "event"];

function WorkflowDialogForm({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const orgId = useAuthStore((state) => state.orgId);
  const workspaceId = useAppStore((state) => state.currentWorkspaceId);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [triggerType, setTriggerType] = React.useState<TriggerType>("manual");

  const mutation = useMutation({
    mutationFn: () => workflowsApi.create({ name: name.trim(), description: description.trim() || null, workspace_id: workspaceId!, trigger_type: triggerType, trigger_config: null }),
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
        <div className="grid gap-1.5"><Label>Trigger type</Label><Select value={triggerType} onValueChange={(value) => setTriggerType(value as TriggerType)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{triggerTypes.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}</SelectContent></Select></div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button disabled={!name.trim() || !workspaceId || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}Create</Button>
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
