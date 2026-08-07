"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { JsonBlock } from "@/components/executions/json-block";
import { executionsApi, type ResumeDecision, type WorkflowRun } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";

/**
 * Sticky approval bar (Vol. 3 §6.1) — rendered only while a run is
 * waiting_approval, because resolving a blocked run is the highest-priority
 * action in this surface.
 *
 * On the prompt text: interrupt_payload is written by human_approval_handler as
 * `{ type: "approval_request", node_outputs: {...} }` — there is NO message
 * string in it. §6.1's wireframe shows a domain sentence ("Approve $4,200.00 to
 * Acme Vendor LLC?") which cannot be derived from this payload, and
 * human_approval nodes have no config to template one from (see
 * apps/web/CLAUDE.md — do not invent a message-template field). So this renders
 * a fixed headline plus the upstream node outputs as the actual evidence to
 * decide on. A templated prompt needs a backend field first.
 *
 * No optimistic update: approve/reject wait for server confirmation.
 */
export function ApprovalActionBar({ run }: { run: WorkflowRun }) {
  const queryClient = useQueryClient();
  const [comment, setComment] = React.useState("");
  const [pendingDecision, setPendingDecision] = React.useState<ResumeDecision | null>(null);

  const mutation = useMutation({
    mutationFn: (decision: ResumeDecision) => executionsApi.resume(run.id, { decision, comment: comment.trim() || null }),
    onSuccess: async (_data, decision) => {
      // Let polling carry the run to its terminal status rather than writing
      // the response into the cache and racing the next poll.
      await queryClient.invalidateQueries({ queryKey: ["execution", run.id] });
      await queryClient.invalidateQueries({ queryKey: ["executions"] });
      setComment("");
      toast.success(decision === "approved" ? "Approved — the run is resuming" : "Run rejected");
    },
    // A 409 here means the run left waiting_approval before this click landed,
    // e.g. another tab decided first. Invalidate so the UI catches up.
    onError: async (error) => {
      toast.error(getApiErrorMessage(error, "Could not record your decision"));
      await queryClient.invalidateQueries({ queryKey: ["execution", run.id] });
    },
    onSettled: () => setPendingDecision(null),
  });

  function decide(decision: ResumeDecision) {
    setPendingDecision(decision);
    mutation.mutate(decision);
  }

  const nodeOutputs = (run.interrupt_payload?.node_outputs ?? null) as Record<string, unknown> | null;

  return (
    <div className="sticky bottom-0 z-10 -mx-4 mt-2 border-t border-amber-200 bg-amber-50/95 p-4 backdrop-blur md:-mx-5 dark:border-amber-400/20 dark:bg-amber-950/40">
      <div className="mx-auto flex max-w-6xl flex-col gap-3">
        <div className="flex items-start gap-2">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">This run is waiting on your approval.</p>
            <p className="text-xs text-muted-foreground">Review what the workflow produced before this point, then approve or reject.</p>
          </div>
        </div>

        {nodeOutputs && Object.keys(nodeOutputs).length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <h4 className="text-xs font-medium text-muted-foreground">Upstream node outputs</h4>
            <JsonBlock value={nodeOutputs} className="max-h-48 bg-background/60" />
          </div>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <Textarea
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="Optional comment recorded with your decision"
            rows={2}
            className="flex-1 bg-background/60"
            disabled={mutation.isPending}
          />
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" onClick={() => decide("rejected")} disabled={mutation.isPending}>
              {pendingDecision === "rejected" ? <Loader2 className="size-4 animate-spin" /> : null}Reject
            </Button>
            <Button onClick={() => decide("approved")} disabled={mutation.isPending}>
              {pendingDecision === "approved" ? <Loader2 className="size-4 animate-spin" /> : null}Approve
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
