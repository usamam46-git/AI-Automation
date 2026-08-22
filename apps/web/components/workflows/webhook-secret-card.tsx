"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { type WebhookSecret, type Workflow, workflowsApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";
import { useAuthStore } from "@/stores/auth-store";

/**
 * Generate / rotate the inbound webhook signing secret.
 *
 * Two contracts from the backend drive the whole shape of this component:
 *
 * 1. **The plaintext is returned exactly once**, by POST
 *    /workflows/{id}/webhook-secret. No read endpoint can recover it — the
 *    workflow response carries only the `has_webhook_secret` bool. So the
 *    revealed value lives in component state and is gone on close, and the
 *    copy affordance has to be right there while it is visible.
 * 2. **Rotation is immediate and has no grace window.** The previous secret
 *    stops verifying the moment this returns, so the button says "Rotate" and
 *    warns, rather than pretending to be idempotent.
 *
 * Gated on `workflow:publish` server-side (handing out this secret lets a
 * bearer start production runs with no login), so a 403 here is a permanent
 * explained state, not a retryable error — same treatment as the Owner-only
 * OpenAI key card.
 */
export function WebhookSecretCard({ workflow }: { workflow: Workflow }) {
  const queryClient = useQueryClient();
  const orgId = useAuthStore((state) => state.orgId);
  const [revealed, setRevealed] = React.useState<WebhookSecret | null>(null);
  const [forbidden, setForbidden] = React.useState(false);

  const rotate = useMutation({
    mutationFn: () => workflowsApi.rotateWebhookSecret(workflow.id),
    onSuccess: async (data) => {
      setRevealed(data);
      await queryClient.invalidateQueries({ queryKey: ["workflows", orgId] });
      toast.success("Signing secret generated — copy it now, it won't be shown again.");
    },
    onError: (error: unknown) => {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 403) {
        setForbidden(true);
        return;
      }
      toast.error(getApiErrorMessage(error, "Could not generate signing secret"));
    },
  });

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Could not copy — select the value and copy manually.");
    }
  }

  if (forbidden) {
    return (
      <div className="rounded-xl border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
        Generating a webhook signing secret requires publish permission on this workflow.
      </div>
    );
  }

  const endpoint = revealed?.endpoint_path ?? `/api/v1/triggers/workflows/${workflow.id}`;

  return (
    <div className="grid gap-2 rounded-xl border border-border/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <KeyRound className="size-4 text-muted-foreground" />
          <span>Signing secret</span>
        </div>
        <Button size="sm" variant={workflow.has_webhook_secret ? "outline" : "default"} disabled={rotate.isPending} onClick={() => rotate.mutate()}>
          {rotate.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          {workflow.has_webhook_secret ? "Rotate" : "Generate"}
        </Button>
      </div>

      <div className="grid gap-1 text-xs text-muted-foreground">
        <span className="font-mono break-all">POST {endpoint}</span>
        <span>Sign {"`{timestamp}.{body}`"} with HMAC-SHA256 and send it as X-AAP-Signature, plus the unix seconds as X-AAP-Timestamp. Requests more than 5 minutes old are rejected.</span>
      </div>

      {revealed ? (
        <div className="grid gap-1.5 rounded-lg bg-muted/50 p-2">
          <div className="flex items-center gap-1.5 text-xs text-status-warn">
            <TriangleAlert className="size-3.5 shrink-0" />
            <span>Copy this now — it is never shown again.</span>
          </div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 font-mono text-xs">{revealed.secret}</code>
            <Button size="sm" variant="ghost" onClick={() => copy(revealed.secret)}><Copy className="size-3.5" /></Button>
          </div>
        </div>
      ) : workflow.has_webhook_secret ? (
        <p className="text-xs text-muted-foreground">A secret is set. Rotating replaces it immediately — callers using the old one will start failing.</p>
      ) : (
        <p className="text-xs text-muted-foreground">No secret yet. This workflow cannot be triggered by webhook until one is generated.</p>
      )}
    </div>
  );
}
