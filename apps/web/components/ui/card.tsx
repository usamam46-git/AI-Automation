import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The Atomie card (2026-08-22).
 *
 * **No border and no shadow.** A card is a FILL one step away from the page
 * (light: page .975 -> card .951; dark: page .150 -> card .200), which is the
 * characteristic move of the reference and the inverse of what this component
 * did before — a white card on a white page held apart by a hairline.
 *
 * Consequences worth knowing before adding a class:
 *   - `border` on a Card is a bug now. If two cards need separating, they need
 *     spacing, not a stroke.
 *   - Nesting a Card in a Card renders invisibly, because both resolve to the
 *     same fill. Use `<CardInset>` for the inner one.
 *   - Anything that genuinely floats (Dialog, Popover, DropdownMenu) uses
 *     `bg-popover` + `shadow-pop` instead, so it reads as ABOVE the page rather
 *     than as another card on it.
 */
function Card({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card" className={cn("rounded-2xl bg-card text-card-foreground", className)} {...props} />;
}

/**
 * A surface nested inside a Card — a code block, a metadata strip, a selected
 * row. One further step in the same direction, so the nesting stays legible
 * without either level drawing an outline.
 */
function CardInset({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-inset" className={cn("rounded-xl bg-surface-2", className)} {...props} />;
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-header" className={cn("flex flex-col gap-1.5 p-5", className)} {...props} />;
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-title" className={cn("font-semibold leading-none tracking-tight", className)} {...props} />;
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-description" className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("p-5 pt-0", className)} {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-footer" className={cn("flex items-center p-5 pt-0", className)} {...props} />;
}

export { Card, CardInset, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };
