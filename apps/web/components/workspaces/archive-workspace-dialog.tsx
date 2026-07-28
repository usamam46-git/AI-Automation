"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { getApiErrorMessage } from "@/lib/api-client";
import { type Workspace, workspacesApi } from "@/lib/api";
import { useAuthStore } from "@/stores/auth-store";
import { useAppStore } from "@/stores/app-store";

export function ArchiveWorkspaceDialog({ workspace, open, onOpenChange }: { workspace: Workspace | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const orgId = useAuthStore((state) => state.orgId);
  const currentWorkspaceId = useAppStore((state) => state.currentWorkspaceId);
  const setCurrentWorkspaceId = useAppStore((state) => state.setCurrentWorkspaceId);

  const mutation = useMutation({
    mutationFn: () => workspacesApi.archive(workspace!.id),
    onSuccess: async () => {
      if (workspace?.id === currentWorkspaceId) setCurrentWorkspaceId(null);
      await queryClient.invalidateQueries({ queryKey: ["workspaces", orgId] });
      toast.success("Workspace archived");
      onOpenChange(false);
    },
    onError: (error) => toast.error(getApiErrorMessage(error, "Could not archive workspace")),
  });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive workspace?</AlertDialogTitle>
          <AlertDialogDescription>
            This archives {workspace?.name ?? "this workspace"}. The API may block this if non-archived workflows are attached.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={mutation.isPending || !workspace} onClick={(event) => { event.preventDefault(); mutation.mutate(); }} className="bg-destructive/10 text-destructive hover:bg-destructive/20">
            Archive
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
