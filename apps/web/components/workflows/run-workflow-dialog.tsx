"use client";

import * as React from "react";
import { Loader2, Play, WandSparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useTriggerRun } from "@/components/workflows/use-trigger-run";
import { formatTriggerPayload, parseTriggerPayload } from "@/lib/trigger-payload";
import type { Workflow } from "@/lib/api";

/**
 * Run a published workflow, optionally with a trigger payload.
 *
 * ## Why this dialog exists at all
 *
 * `RunTriggerRequest.trigger_payload` has been accepted by the API since the
 * executions module shipped, and no UI ever sent one — every Run-now click
 * posted `{}`. An agent node reading `input_fields: ["trigger_payload"]`
 * therefore received an empty object on every manual run, which is fine for a
 * workflow with a static query and useless for one that extracts from a
 * document. The 15-day plan's day-1 notes flagged it; this closes it, and it is
 * what makes the demo's expense and HR workflows runnable from the browser
 * rather than only from a terminal.
 *
 * ## Why the box is optional and blank by default
 *
 * `parseTriggerPayload("")` is `{}`, so pressing Run without typing anything is
 * byte-identical to the old behaviour. That matters: the HR assistant is meant
 * to be demoed with one click, and a dialog that demanded JSON first would take
 * that away.
 *
 * ## Why it does not validate against the workflow
 *
 * There is nothing to validate against. A trigger payload has no schema
 * anywhere — an agent node's `input_fields` addresses it with dotted paths at
 * run time, and the backend takes any JSON object. Guessing at required keys
 * would reject payloads the workflow would happily accept.
 */
export function RunWorkflowDialog({
  workflow,
  open,
  onOpenChange,
}: {
  workflow: Workflow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {workflow ? (
        <DialogContent>
          {/*
            The form is a separate component so that closing the dialog
            *unmounts* it and a reopen starts blank. Radix removes DialogContent
            from the tree when closed, so the reset is free — the alternative, a
            `setRaw("")` inside an effect keyed on `open`, is a cascading render
            and `react-hooks/set-state-in-effect` rejects it. The `key` covers
            the remaining case: switching workflows while the dialog is already
            open, where nothing would otherwise unmount and a payload typed for
            one workflow would be submitted against another.
          */}
          <RunWorkflowForm key={workflow.id} workflow={workflow} onOpenChange={onOpenChange} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function RunWorkflowForm({ workflow, onOpenChange }: { workflow: Workflow; onOpenChange: (open: boolean) => void }) {
  const [raw, setRaw] = React.useState("");
  const triggerRun = useTriggerRun();

  const parsed = parseTriggerPayload(raw);
  const isWebhook = workflow.trigger_type === "webhook";

  function run() {
    if (!parsed.ok) return;
    triggerRun.mutate({ workflowId: workflow.id, triggerPayload: parsed.value }, { onSuccess: () => onOpenChange(false) });
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Run {workflow.name}</DialogTitle>
        <DialogDescription>
          {isWebhook
            ? "This workflow is webhook-triggered. Running it here starts a manual run with whatever payload you supply — a useful way to test the graph without signing a request."
            : "Optionally supply a trigger payload. Leave it blank to run with no input."}
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="trigger-payload">Trigger payload (JSON)</Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            disabled={!parsed.ok || raw.trim() === ""}
            onClick={() => setRaw((current) => formatTriggerPayload(current))}
          >
            <WandSparkles className="size-3.5" />
            Format
          </Button>
        </div>
        <Textarea
          id="trigger-payload"
          value={raw}
          onChange={(event) => setRaw(event.target.value)}
          placeholder={'{\n  "question": "How much notice do I have to give?"\n}'}
          rows={10}
          spellCheck={false}
          className="font-mono text-xs"
          disabled={triggerRun.isPending}
          aria-invalid={!parsed.ok}
          aria-describedby={parsed.ok ? undefined : "trigger-payload-error"}
        />
        {parsed.ok ? (
          <p className="text-xs text-muted-foreground">
            Reachable in the graph as <code className="font-mono">trigger_payload</code>, and by dotted path from an agent&apos;s{" "}
            <code className="font-mono">input_fields</code> or a tool&apos;s field maps.
          </p>
        ) : (
          <p id="trigger-payload-error" className="text-xs text-destructive">
            {parsed.error}
          </p>
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={triggerRun.isPending}>
          Cancel
        </Button>
        <Button onClick={run} disabled={!parsed.ok || triggerRun.isPending}>
          {triggerRun.isPending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
          Run
        </Button>
      </DialogFooter>
    </>
  );
}
