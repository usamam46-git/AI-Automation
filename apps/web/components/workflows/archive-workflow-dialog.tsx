"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { type Workflow, workflowsApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";
import { useAuthStore } from "@/stores/auth-store";

export function ArchiveWorkflowDialog({ workflow, open, onOpenChange }: { workflow: Workflow | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const orgId = useAuthStore((state) => state.orgId);
  const mutation = useMutation({
    mutationFn: () => workflowsApi.archive(workflow!.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["workflows", orgId] });
      toast.success("Workflow archived");
      onOpenChange(false);
    },
    onError: (error) => toast.error(getApiErrorMessage(error, "Could not archive workflow")),
  });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive workflow?</AlertDialogTitle>
          <AlertDialogDescription>This archives {workflow?.name ?? "this workflow"}. Runs and builder operations are not available in this phase.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={mutation.isPending || !workflow} onClick={(event) => { event.preventDefault(); mutation.mutate(); }} className="bg-destructive/10 text-destructive hover:bg-destructive/20">Archive</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
