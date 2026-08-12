"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import axios from "axios";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { type Tool, toolsApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";
import { useAuthStore } from "@/stores/auth-store";

/**
 * Delete is **soft** on the server — `tool_executions.tool_id` cascades, so a
 * hard delete would destroy the audit trail Vol. 4 §4.3 exists to create.
 *
 * The 409 case is rendered in place rather than as a toast, because it is a
 * permanent explained state, not a transient failure: the tool is referenced by
 * a *published* workflow version, and retrying cannot change that. (Draft
 * references deliberately do not block — the author is still editing.) Same
 * treatment as the Owner-only integrations card.
 */
export function DeleteToolDialog({ tool, open, onOpenChange }: { tool: Tool | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const orgId = useAuthStore((state) => state.orgId);
  const [blockedReason, setBlockedReason] = React.useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => toolsApi.remove(tool!.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["tools", orgId] });
      toast.success("Tool deleted");
      onOpenChange(false);
    },
    onError: (error) => {
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        setBlockedReason(getApiErrorMessage(error, "This tool is still in use."));
        return;
      }
      toast.error(getApiErrorMessage(error, "Could not delete tool"));
    },
  });

  function handleOpenChange(next: boolean) {
    if (!next) setBlockedReason(null);
    onOpenChange(next);
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{blockedReason ? "This tool is still in use" : "Delete tool?"}</AlertDialogTitle>
          <AlertDialogDescription>
            {blockedReason
              ? `${blockedReason} Point those nodes at another tool and publish a new version first.`
              : `${tool?.name ?? "This tool"} stops being available to new nodes. Existing runs and the tool's execution history are kept.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{blockedReason ? "Close" : "Cancel"}</AlertDialogCancel>
          {blockedReason ? null : (
            <AlertDialogAction
              disabled={mutation.isPending || !tool}
              onClick={(event) => {
                event.preventDefault();
                mutation.mutate();
              }}
              className="bg-destructive/10 text-destructive hover:bg-destructive/20"
            >
              Delete
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
