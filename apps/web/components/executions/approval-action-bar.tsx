"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { JsonBlock } from "@/components/executions/json-block";
import { buildApprovalSummary } from "@/lib/approval-summary";
import { executionsApi, type ResumeDecision, type WorkflowRun } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";

/**
 * Sticky approval bar (Vol. 3 §6.1) — rendered only while a run is
 * waiting_approval, because resolving a blocked run is the highest-priority
 * action in this surface.
 *
 * On the prompt text: interrupt_payload is written by human_approval_handler as
 * `{ type: "approval_request", node_outputs: {...} }` — there is NO message
 * string in it, and a `human_approval` node has no config to template one from.
 * §6.1's wireframe nevertheless shows a domain sentence ("Approve $4,200.00 to
 * Acme Vendor LLC?").
 *
 * **That sentence is now derived on the client** — `lib/approval-summary.ts`,
 * per the 15-day plan §4, which settles approval copy as a frontend concern
 * rather than a missing backend field. Do NOT read this as licence to add a
 * message-template field to `human_approval`: the backend contract deliberately
 * has none, and the derivation reads only what the workflow actually produced.
 *
 * The raw node outputs stay on screen underneath, and that is not redundancy.
 * The summary is a convention over field names which a workflow is free not to
 * follow, so a reviewer authorising a write to a real system must always be
 * able to see everything it was drawn from.
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
  const summary = buildApprovalSummary(nodeOutputs);

  return (
    <div className="sticky bottom-0 z-10 -mx-4 mt-2 rounded-t-2xl bg-status-warn-soft/95 p-5 backdrop-blur md:-mx-6">
      <div className="mx-auto flex max-w-6xl flex-col gap-3">
        <div className="flex items-start gap-2">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-status-warn" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className={summary.derived ? "text-base font-semibold" : "text-sm font-medium"}>{summary.headline}</p>
            {summary.rationale ? <p className="text-sm">{summary.rationale}</p> : null}
            {summary.facts.length > 0 ? (
              <dl className="flex flex-wrap gap-x-4 gap-y-1 pt-0.5 text-xs text-muted-foreground">
                {summary.facts.map((fact) => (
                  <div key={fact.label} className="flex gap-1.5">
                    <dt>{fact.label}</dt>
                    <dd className="font-medium text-foreground">{fact.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {summary.derived
                ? "Nothing has been written yet. Review the evidence below, then approve or reject."
                : "Review what the workflow produced before this point, then approve or reject."}
            </p>
          </div>
        </div>

        {summary.findings.length > 0 ? (
          <ul className="flex list-disc flex-col gap-1 rounded-xl bg-background/60 p-3 pl-7 text-xs">
            {summary.findings.map((finding) => (
              <li key={finding}>{finding}</li>
            ))}
          </ul>
        ) : null}

        {summary.citation ? (
          <blockquote className="border-l-2 border-status-warn pl-3 text-xs italic text-muted-foreground">{summary.citation}</blockquote>
        ) : null}

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
