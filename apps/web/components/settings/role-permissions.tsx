"use client";

import * as React from "react";
import { Check, Minus, ShieldAlert } from "lucide-react";

import { cn } from "@/lib/utils";
import { grantSummary, groupPermissions, permissionInfo } from "@/lib/permissions";

/**
 * What a role actually grants, grouped and contrasted against what it withholds.
 *
 * Built for the moment of assignment. "Editor can build workflows" answers half
 * the question someone picking a role is asking; the other half is "and what
 * can't they do?", which a list of ticks cannot answer on its own. So withheld
 * capabilities are rendered too, dimmed — the contrast is the information.
 *
 * Reads `effective_permissions` only. See the header of `lib/permissions.ts`
 * for why the wildcard rules are never resolved on this side.
 */
export function RolePermissions({
  effective,
  className,
  showWithheld = true,
}: {
  effective: readonly string[];
  className?: string;
  showWithheld?: boolean;
}) {
  const groups = React.useMemo(() => groupPermissions(effective), [effective]);
  const summary = grantSummary(effective);

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <p className="text-xs text-muted-foreground">
        Grants <span className="font-medium text-foreground">{summary.granted}</span> of {summary.total} capabilities.
      </p>

      {groups.map(({ group, granted, withheld }) => (
        <div key={group.id}>
          <div className="flex items-baseline justify-between gap-2">
            <h4 className="text-xs font-semibold">{group.label}</h4>
            <span className="text-[11px] text-muted-foreground">
              {granted.length}/{granted.length + withheld.length}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground/80">{group.caption}</p>

          <ul className="mt-1.5 space-y-1">
            {granted.map((permission) => (
              <PermissionLine key={permission} permission={permission} granted />
            ))}
            {showWithheld
              ? withheld.map((permission) => <PermissionLine key={permission} permission={permission} granted={false} />)
              : null}
          </ul>
        </div>
      ))}
    </div>
  );
}

function PermissionLine({ permission, granted }: { permission: string; granted: boolean }) {
  const info = permissionInfo(permission);
  return (
    <li className={cn("flex items-start gap-1.5 text-xs", granted ? "text-foreground" : "text-muted-foreground/55")}>
      {granted ? (
        <Check className="mt-0.5 size-3 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
      ) : (
        <Minus className="mt-0.5 size-3 shrink-0" aria-hidden />
      )}
      <span className={cn(!granted && "line-through decoration-muted-foreground/30")}>{info.label}</span>
      {/* Flagged only when actually held — a warning next to something the role
          cannot do would read as a risk it does not carry. */}
      {granted && info.sensitive ? (
        <ShieldAlert className="mt-0.5 size-3 shrink-0 text-amber-600 dark:text-amber-400" aria-label="Sensitive capability" />
      ) : null}
      <span className="sr-only">{granted ? "granted" : "not granted"}</span>
    </li>
  );
}
