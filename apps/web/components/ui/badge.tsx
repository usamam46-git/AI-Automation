import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center rounded-lg border px-2 py-0.5 text-xs font-medium transition-colors", {
  variants: {
    variant: {
      default: "border-transparent bg-primary text-primary-foreground",
      secondary: "border-transparent bg-secondary text-secondary-foreground",
      outline: "border-border text-foreground",
      // Workflow-shell status.
      draft: "border-zinc-200 bg-zinc-100 text-zinc-700 dark:border-white/10 dark:bg-white/10 dark:text-zinc-200",
      published: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-300",
      archived: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-300",
      soon: "border-border bg-muted text-muted-foreground",
      // Run status (Vol. 3 §5's "one status vocabulary everywhere"). The
      // blueprint names these --color-status-* tokens; this cva is where that
      // vocabulary actually lives, so run statuses extend it rather than
      // forking a parallel token set. Desaturated per §3.1 — never bright.
      pending: "border-zinc-200 bg-zinc-100 text-zinc-600 dark:border-white/10 dark:bg-white/10 dark:text-zinc-300",
      running: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-400/20 dark:bg-sky-400/10 dark:text-sky-300",
      waiting_approval: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-300",
      completed: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-300",
      failed: "border-red-200 bg-red-50 text-red-700 dark:border-red-400/20 dark:bg-red-400/10 dark:text-red-300",
      rejected: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-400/20 dark:bg-rose-400/10 dark:text-rose-300",
      cancelled: "border-zinc-200 bg-zinc-100 text-zinc-600 dark:border-white/10 dark:bg-white/10 dark:text-zinc-300",
      // A tool that writes to an external system (Vol. 4 §4.3). Amber, not red:
      // a mutating tool is a normal thing to register, not an error — what it
      // signals is that publishing needs an upstream approval node.
      mutating: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-300",
    },
  },
  defaultVariants: { variant: "default" },
});

function Badge({ className, variant, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
