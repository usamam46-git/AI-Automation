"use client";

import Link from "next/link";
import { ArrowLeft, CircleAlert, Loader2, Play, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { SaveState } from "@/hooks/use-workflow-autosave";
import type { Workflow } from "@/lib/api";
import type { GraphIssue } from "@/lib/graph-validation";
import { cn } from "@/lib/utils";

export function BuilderToolbar({
  workflow,
  versionNumber,
  publishedAt,
  saveState,
  saveError,
  bannerIssues,
  publishBlockingCount,
  onPublish,
  publishPending,
  onTestRun,
  testRunPending,
}: {
  workflow: Workflow;
  versionNumber: number | null;
  publishedAt: string | null;
  saveState: SaveState;
  saveError: string | null;
  /** Issues with no attributable node — they would otherwise be dropped. */
  bannerIssues: GraphIssue[];
  publishBlockingCount: number;
  onPublish: () => void;
  publishPending: boolean;
  onTestRun: () => void;
  testRunPending: boolean;
}) {
  const isPublished = Boolean(publishedAt);
  const canTestRun = Boolean(workflow.current_version_id);
  // Publishing the stored draft while the canvas still holds unsaved edits would
  // publish the wrong graph, so wait for autosave to land first.
  const pendingSave = saveState === "saving" || saveState === "unsaved";
  const canPublish = versionNumber !== null && !isPublished && !pendingSave && publishBlockingCount === 0;

  return (
    <div className="shrink-0 border-b border-border bg-background">
      <div className="flex h-14 items-center gap-3 px-3 md:px-4">
        <Button asChild variant="ghost" size="icon" aria-label="Back to workflows">
          <Link href="/workflows">
            <ArrowLeft className="size-4" />
          </Link>
        </Button>

        <div className="min-w-0">
          <div className="truncate text-sm font-medium leading-tight">{workflow.name}</div>
          <div className="truncate text-[11px] leading-tight text-muted-foreground">
            {versionNumber === null ? "No version yet" : `Version ${versionNumber}`}
            {" · "}
            <SaveIndicator state={saveState} error={saveError} />
          </div>
        </div>

        <Separator orientation="vertical" className="mx-1 h-6" />
        <Badge variant={isPublished ? "published" : "draft"}>{isPublished ? "published" : "draft"}</Badge>

        <div className="ml-auto flex items-center gap-2">
          <PublishButton
            canPublish={canPublish}
            isPublished={isPublished}
            hasVersion={versionNumber !== null}
            saving={pendingSave}
            blockingCount={publishBlockingCount}
            pending={publishPending}
            onPublish={onPublish}
          />
          <TestRunButton canTestRun={canTestRun} pending={testRunPending} onTestRun={onTestRun} />
        </div>
      </div>

      {isPublished ? (
        <Banner tone="info">
          Version {versionNumber} is published and immutable. Your next edit starts version {(versionNumber ?? 0) + 1} as a
          draft.
        </Banner>
      ) : canTestRun ? (
        // A published version is live while this draft is not — without saying
        // so, the "draft" badge reads as though the workflow stopped working.
        <Banner tone="info">
          An earlier version is live and still runs. Publish version {versionNumber} to replace it.
        </Banner>
      ) : null}

      {bannerIssues.map((issue) => (
        <Banner key={`${issue.rule}-${issue.message}`} tone="error">
          {issue.message}
        </Banner>
      ))}
    </div>
  );
}

function SaveIndicator({ state, error }: { state: SaveState; error: string | null }) {
  if (state === "saving") return <span>Saving…</span>;
  if (state === "saved") return <span>Saved</span>;
  if (state === "unsaved") return <span>Unsaved changes</span>;
  if (state === "error") return <span className="text-destructive">{error ?? "Save failed"}</span>;
  return <span>Up to date</span>;
}

function PublishButton({
  canPublish,
  isPublished,
  hasVersion,
  saving,
  blockingCount,
  pending,
  onPublish,
}: {
  canPublish: boolean;
  isPublished: boolean;
  hasVersion: boolean;
  saving: boolean;
  blockingCount: number;
  pending: boolean;
  onPublish: () => void;
}) {
  const reason = !hasVersion
    ? "Add a node first — there is nothing to publish yet."
    : isPublished
      ? "This version is already published. Edit the graph to start a new draft."
      : saving
        ? "Waiting for the draft to finish saving."
        : blockingCount > 0
          ? `The draft cannot be saved yet — fix the ${blockingCount === 1 ? "problem" : "problems"} on the canvas first.`
          : null;

  const button = (
    <Button size="sm" className="h-8" disabled={!canPublish || pending} onClick={onPublish}>
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
      Publish
    </Button>
  );

  if (!reason) return button;
  return (
    <Tooltip>
      {/* A disabled button swallows pointer events, so the trigger needs a wrapper. */}
      <TooltipTrigger asChild>
        <span tabIndex={0}>{button}</span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

function TestRunButton({ canTestRun, pending, onTestRun }: { canTestRun: boolean; pending: boolean; onTestRun: () => void }) {
  const button = (
    <Button variant="outline" size="sm" className="h-8" disabled={!canTestRun || pending} onClick={onTestRun}>
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
      Test run
    </Button>
  );

  if (canTestRun) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0}>{button}</span>
      </TooltipTrigger>
      <TooltipContent>Publish a version first — a run needs a published graph.</TooltipContent>
    </Tooltip>
  );
}

function Banner({ tone, children }: { tone: "info" | "error"; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-start gap-1.5 border-t px-3 py-1.5 text-[11px] leading-snug",
        tone === "error"
          ? "border-border bg-status-bad-soft text-status-bad"
          : "border-border bg-surface-2 text-muted-foreground",
      )}
    >
      {tone === "error" ? <CircleAlert className="mt-px size-3.5 shrink-0" /> : null}
      <span>{children}</span>
    </div>
  );
}
