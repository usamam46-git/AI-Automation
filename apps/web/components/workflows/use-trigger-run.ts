"use client";

import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { executionsApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";

/**
 * Triggers a run and navigates to its Execution Viewer page, which is where the
 * user watches it reach waiting_approval and acts on it.
 *
 * Shared by the workflows list row menu and the workflow detail dialog so both
 * entry points behave identically. The 422 ("no published version") from
 * ExecutionService.trigger_run surfaces as a toast — the callers also disable
 * the action when current_version_id is null, but that check is advisory and
 * the server stays the authority.
 */
export function useTriggerRun() {
  const router = useRouter();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (workflowId: string) => executionsApi.triggerRun(workflowId, { trigger_payload: {} }),
    onSuccess: (run) => {
      queryClient.invalidateQueries({ queryKey: ["executions"] });
      router.push(`/executions/${run.id}`);
    },
    onError: (error) => toast.error(getApiErrorMessage(error, "Could not start a run")),
  });
}
