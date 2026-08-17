"use client";

import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { executionsApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";

export interface TriggerRunVariables {
  workflowId: string;
  /** Omitted or empty sends `{}` — the behaviour every caller had before the
   *  Run dialog existed. */
  triggerPayload?: Record<string, unknown>;
}

/**
 * Triggers a run and navigates to its Execution Viewer page, which is where the
 * user watches it reach waiting_approval and acts on it.
 *
 * Shared by the workflows list row menu, the workflow detail dialog and the
 * Builder's Test Run so all three behave identically. The 422 ("no published
 * version") from ExecutionService.trigger_run surfaces as a toast — the callers
 * also disable the action when current_version_id is null, but that check is
 * advisory and the server stays the authority.
 *
 * **The variables are an object, not a bare workflow id.** They were a bare
 * string until the Run dialog landed; a second positional argument would have
 * been cheaper but React Query passes exactly one value to `mutationFn`, and
 * threading an optional payload through as a tuple makes every call site read
 * as an anonymous pair. Adding the third variable this will eventually want
 * (an idempotency key, most likely) then costs nothing.
 */
export function useTriggerRun() {
  const router = useRouter();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ workflowId, triggerPayload }: TriggerRunVariables) =>
      executionsApi.triggerRun(workflowId, { trigger_payload: triggerPayload ?? {} }),
    onSuccess: (run) => {
      queryClient.invalidateQueries({ queryKey: ["executions"] });
      router.push(`/executions/${run.id}`);
    },
    onError: (error) => toast.error(getApiErrorMessage(error, "Could not start a run")),
  });
}
