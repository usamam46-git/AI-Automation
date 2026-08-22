import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * The one status vocabulary (Vol. 3 §5, "one status vocabulary everywhere").
 *
 * As of the Atomie pass (2026-08-22) the colours are no longer written here as
 * Tailwind palette classes with hand-written `dark:` twins. They come from the
 * `--color-status-*` tokens in `globals.css` — the set the blueprint always
 * named and that had never existed. `components/dashboard/stat-card.tsx` and
 * `lib/node-catalog.ts` read the same tokens, so the three surfaces can no
 * longer drift, and a theme change is one edit instead of thirty.
 *
 * Two rules the shapes encode:
 *   - **No border.** Same reason a Card has none: a chip is a tinted fill, and
 *     an outline around a fill is the thing this language removed.
 *   - **Nothing here is lime.** Lime is the brand and marks the primary action.
 *     A lime `completed` chip would put the two vocabularies on one screen
 *     saying different things in the same colour.
 */
const badgeVariants = cva(
  "inline-flex items-center rounded-lg px-2 py-0.5 text-xs font-medium transition-colors",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        secondary: "bg-surface-2 text-secondary-foreground",
        outline: "border border-border text-foreground",
        // Brand chip. The one place lime is allowed on a badge, and it is not a
        // status — it marks the org's own default, not a run outcome.
        brand: "bg-lime-soft text-lime-ink dark:bg-lime/15 dark:text-lime",

        // Workflow-shell status.
        draft: "bg-status-neutral-soft text-status-neutral",
        published: "bg-status-ok-soft text-status-ok",
        archived: "bg-status-warn-soft text-status-warn",
        soon: "bg-surface-2 text-muted-foreground",

        // Run status.
        pending: "bg-status-neutral-soft text-status-neutral",
        running: "bg-status-info-soft text-status-info",
        waiting_approval: "bg-status-warn-soft text-status-warn",
        completed: "bg-status-ok-soft text-status-ok",
        failed: "bg-status-bad-soft text-status-bad",
        rejected: "bg-status-bad-soft text-status-bad",
        cancelled: "bg-status-neutral-soft text-status-neutral",

        // A tool that writes to an external system (Vol. 4 §4.3). Warn, not bad:
        // registering a mutating tool is normal — what the chip signals is that
        // publishing will need an upstream approval node.
        mutating: "bg-status-warn-soft text-status-warn",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Badge({ className, variant, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
