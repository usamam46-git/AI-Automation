"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Minus, ShieldAlert } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { membersApi } from "@/lib/api";
import { roleBlurb } from "@/lib/members";
import { PERMISSION_GROUPS, PERMISSION_INFO, permissionInfo } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth-store";

/**
 * Vol. 3 §10's "Roles & Permissions" page, read-only half.
 *
 * The blueprint specifies a custom-role builder — "a checkbox matrix over the
 * permission-string vocabulary" — for the enterprise plan. Custom roles are not
 * built (nothing writes an org-owned `roles` row), so this renders the same
 * matrix as a **reference** rather than an editor. That is the honest version:
 * the grid is real, read from `/organizations/roles`, and every tick is a
 * permission the API actually enforces.
 *
 * Owner is included even though it cannot be assigned — someone reading this
 * table is asking "who can do X", and leaving out the role that can do
 * everything would answer that wrongly.
 */
export function RolesMatrixCard() {
  const orgId = useAuthStore((state) => state.orgId);
  const [open, setOpen] = React.useState(false);

  const rolesQuery = useQuery({
    queryKey: ["members", "roles", orgId],
    queryFn: () => membersApi.roles(),
    enabled: Boolean(orgId),
    staleTime: Infinity,
  });

  const roles = React.useMemo(() => rolesQuery.data ?? [], [rolesQuery.data]);
  const grantSets = React.useMemo(() => new Map(roles.map((role) => [role.name, new Set(role.effective_permissions)])), [roles]);

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 p-4 text-left transition-colors hover:bg-muted/40"
      >
        <div>
          <h3 className="text-sm font-semibold">Roles &amp; permissions</h3>
          <p className="text-xs text-muted-foreground">
            Exactly what each role can do. Owner is shown for reference — it cannot be assigned.
          </p>
        </div>
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
      </button>

      {open ? (
        <div className="border-t border-border p-4">
          {rolesQuery.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, index) => (
                <Skeleton key={index} className="h-6 w-full" />
              ))}
            </div>
          ) : (
            <>
              <div className="mb-3 grid gap-1.5 sm:grid-cols-2">
                {roles.map((role) => (
                  <p key={role.id} className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{role.name}</span> — {roleBlurb(role.name)}
                  </p>
                ))}
              </div>

              {/* Wide content scrolls inside its own container so the settings
                  page body never scrolls horizontally. */}
              <div className="overflow-x-auto">
                <table className="w-full min-w-[34rem] border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="py-2 pr-3 text-left font-medium">Capability</th>
                      {roles.map((role) => (
                        <th key={role.id} className="px-2 py-2 text-center font-medium">
                          {role.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {PERMISSION_GROUPS.map((group) => {
                      const permissions = Object.keys(permissionsInGroup(group.id));
                      if (permissions.length === 0) return null;
                      return (
                        <React.Fragment key={group.id}>
                          <tr>
                            <td colSpan={roles.length + 1} className="pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                              {group.label}
                            </td>
                          </tr>
                          {permissions.map((permission) => {
                            const info = permissionInfo(permission);
                            return (
                              <tr key={permission} className="border-b border-border/50 last:border-b-0">
                                <td className="py-1.5 pr-3">
                                  <span className="flex items-center gap-1.5">
                                    {info.label}
                                    {info.sensitive ? (
                                      <ShieldAlert className="size-3 shrink-0 text-amber-600 dark:text-amber-400" aria-label="Sensitive" />
                                    ) : null}
                                  </span>
                                </td>
                                {roles.map((role) => {
                                  const granted = grantSets.get(role.name)?.has(permission) ?? false;
                                  return (
                                    <td key={role.id} className="px-2 py-1.5 text-center">
                                      {granted ? (
                                        <Check className="mx-auto size-3.5 text-emerald-600 dark:text-emerald-400" aria-label="granted" />
                                      ) : (
                                        <Minus className="mx-auto size-3.5 text-muted-foreground/35" aria-label="not granted" />
                                      )}
                                    </td>
                                  );
                                })}
                              </tr>
                            );
                          })}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <p className="mt-3 flex items-start gap-1.5 text-[11px] text-muted-foreground">
                <ShieldAlert className="mt-0.5 size-3 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                Marked capabilities change or expose something consequential — credentials, spend, published workflows, or the
                audit trail.
              </p>
            </>
          )}
        </div>
      ) : null}
    </Card>
  );
}

/** Read straight off the pure module, so this table and the breakdown list can
 *  never disagree about which permissions exist. */
function permissionsInGroup(groupId: string): Record<string, true> {
  const out: Record<string, true> = {};
  for (const [permission, info] of Object.entries(PERMISSION_INFO)) {
    if (info.group === groupId) out[permission] = true;
  }
  return out;
}
