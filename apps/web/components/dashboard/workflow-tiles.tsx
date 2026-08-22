"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { Workflow } from "@/lib/api";

/**
 * §5.1's "Your Workflows" tile grid.
 *
 * Each tile links to the Builder rather than a detail page: from the dashboard,
 * the thing you want to do with a workflow is open it. The workflows list page
 * remains the place for run/archive/rotate-secret actions, so the row menu is
 * deliberately not duplicated here.
 */
export function WorkflowTiles({
  workflows,
  loading,
  onCreate,
}: {
  workflows: Workflow[];
  loading: boolean;
  onCreate: () => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="app-eyebrow">Your Workflows</h2>
        <button
          onClick={onCreate}
          className="flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <Plus className="size-3.5" /> New
        </button>
      </div>

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Card key={index} className="flex flex-col gap-3 p-4">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-5 w-16" />
            </Card>
          ))}
        </div>
      ) : workflows.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 p-6 text-center">
          <div>
            <p className="text-sm font-semibold">No workflows yet</p>
            <p className="mt-1 text-sm text-muted-foreground">Create one to start automating.</p>
          </div>
          <button onClick={onCreate} className="text-sm font-medium text-foreground underline underline-offset-4">
            Create a workflow
          </button>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {workflows.map((workflow) => (
            <Link
              key={workflow.id}
              href={`/workflows/${workflow.id}/builder`}
              className="rounded-2xl focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
            >
              <Card className="flex h-full flex-col justify-between gap-4 p-4 transition-colors hover:bg-surface-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{workflow.name}</p>
                  <p className="mt-0.5 truncate text-xs capitalize text-muted-foreground">{workflow.trigger_type} trigger</p>
                </div>
                <Badge variant={workflow.status} className="w-fit capitalize">
                  {workflow.status}
                </Badge>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
