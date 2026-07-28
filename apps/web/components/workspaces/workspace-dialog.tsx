"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getApiErrorMessage } from "@/lib/api-client";
import { type Workspace, workspacesApi } from "@/lib/api";
import { useAuthStore } from "@/stores/auth-store";

function WorkspaceDialogForm({ onOpenChange, workspace }: { onOpenChange: (open: boolean) => void; workspace?: Workspace | null }) {
  const queryClient = useQueryClient();
  const orgId = useAuthStore((state) => state.orgId);
  const [name, setName] = React.useState(workspace?.name ?? "");
  const [icon, setIcon] = React.useState(workspace?.icon ?? "");
  const isEditing = Boolean(workspace);

  const mutation = useMutation({
    mutationFn: () =>
      isEditing && workspace
        ? workspacesApi.update(workspace.id, { name: name.trim(), icon: icon.trim() || null })
        : workspacesApi.create({ name: name.trim(), icon: icon.trim() || null }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["workspaces", orgId] });
      toast.success(isEditing ? "Workspace renamed" : "Workspace created");
      onOpenChange(false);
    },
    onError: (error) => toast.error(getApiErrorMessage(error, "Could not save workspace")),
  });

  const nameError = name.length > 0 && name.trim().length === 0 ? "Enter a workspace name." : null;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{isEditing ? "Rename workspace" : "New workspace"}</DialogTitle>
        <DialogDescription>{isEditing ? "Update the workspace label and icon." : "Create a workspace inside the current organization."}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="workspace-name">Name</Label>
          <Input id="workspace-name" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          {nameError ? <p className="text-xs text-destructive">{nameError}</p> : null}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="workspace-icon">Icon</Label>
          <Input id="workspace-icon" value={icon} onChange={(event) => setIcon(event.target.value)} placeholder="Optional emoji or short code" />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} type="button">Cancel</Button>
        <Button disabled={!name.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
          {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          {isEditing ? "Save" : "Create"}
        </Button>
      </DialogFooter>
    </>
  );
}

export function WorkspaceDialog({ open, onOpenChange, workspace }: { open: boolean; onOpenChange: (open: boolean) => void; workspace?: Workspace | null }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {open ? <WorkspaceDialogForm key={workspace?.id ?? "new"} onOpenChange={onOpenChange} workspace={workspace} /> : null}
      </DialogContent>
    </Dialog>
  );
}
