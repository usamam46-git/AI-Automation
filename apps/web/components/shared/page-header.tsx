import * as React from "react";

/**
 * The standard page header for every route under `app/(dashboard)/`.
 *
 * It exists because the title used to be rendered TWICE on every page: the
 * shell painted `<h1>{title}</h1>` from its nav table, and then each page
 * painted its own `<h2>Workflows</h2>` two rows below it. The shell no longer
 * carries a title at all — it holds the workspace, the theme and the account —
 * and the page owns its own heading, which is also the only place that knows
 * what its primary action is.
 *
 * The eyebrow is the reference's `/ Dashboard` label (`.app-eyebrow` in
 * globals.css draws the lime slash via `::before`, so it never lands in the
 * accessible name).
 *
 * `action` is deliberately singular. One lime action per screen is what makes
 * the accent mean anything — a row of three primary buttons is a row of three
 * things none of which is primary. Secondary controls belong in `aside`.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  action,
  aside,
}: {
  /** Short section label. Defaults to the title when omitted. */
  eyebrow?: string;
  title: string;
  description?: React.ReactNode;
  /** The single primary action. Render a lime `<Button>` here. */
  action?: React.ReactNode;
  /** Filters, toggles, anything that is not the primary action. */
  aside?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <span className="app-eyebrow">{eyebrow ?? title}</span>
        <h1 className="mt-1.5 text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action || aside ? (
        <div className="flex shrink-0 items-center gap-2">
          {aside}
          {action}
        </div>
      ) : null}
    </header>
  );
}
