"use client";

import * as React from "react";
import { ArrowRight, Minus, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RolePermissions } from "@/components/settings/role-permissions";
import { ASSIGNABLE_ROLES, type AssignableRole, type Member, type RoleOption } from "@/lib/api";
import { memberDisplayName, roleBlurb } from "@/lib/members";
import { findRole, permissionInfo, roleDiff } from "@/lib/permissions";

/**
 * Reassign a member's role, with the consequences on screen.
 *
 * This replaced a row of bare `Make Admin` / `Make Viewer` menu items. Those
 * were one click from changing what a colleague can do to production workflows,
 * with nothing anywhere saying what that meant — the gap this dialog exists to
 * close. The gained/lost diff is the part that matters: a full permission list
 * for the new role still leaves the reader diffing two screens by eye.
 */
export function ChangeRoleDialog({
  member,
  roles,
  open,
  onOpenChange,
  onConfirm,
  isPending,
}: {
  member: Member | null;
  roles: RoleOption[] | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (role: AssignableRole) => void;
  isPending: boolean;
}) {
  // Resetting when the dialog is pointed at a different person is done with a
  // `key` on this component in members-card.tsx, not with an effect — React
  // remounts on a changed key, which is the idiomatic reset and avoids a
  // synchronous setState inside an effect.
  const [target, setTarget] = React.useState<AssignableRole | null>(null);

  if (!member) return null;

  const current = findRole(roles, member.role_name);
  const next = target ? findRole(roles, target) : undefined;
  const diff = next ? roleDiff(current?.effective_permissions ?? [], next.effective_permissions) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Change role for {memberDisplayName(member)}</DialogTitle>
          <DialogDescription>
            {member.status === "invited"
              ? "This invitation has not been accepted yet — the new role applies when they join."
              : "Takes effect immediately, including for sessions they already have open."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="rounded-lg border border-border px-2 py-1 font-medium">{member.role_name}</span>
          <ArrowRight className="size-4 text-muted-foreground" aria-hidden />
          <Select value={target ?? ""} onValueChange={(value) => setTarget(value as AssignableRole)}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Choose a new role" />
            </SelectTrigger>
            <SelectContent>
              {/* Driven by the API's `assignable` flag, falling back to the
                  shared constant before roles load. Owner is excluded by the
                  flag, not by this list happening to omit it. */}
              {(roles?.filter((r) => r.assignable).map((r) => r.name) ?? [...ASSIGNABLE_ROLES])
                .filter((role) => role !== member.role_name)
                .map((role) => (
                  <SelectItem key={role} value={role}>
                    {role}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>

        {next ? (
          <>
            <p className="text-xs text-muted-foreground">{roleBlurb(next.name)}</p>

            <div className="grid gap-3 sm:grid-cols-2">
              <DiffColumn
                title="They gain"
                permissions={diff!.gained}
                tone="gain"
                empty="Nothing new — this role is narrower."
              />
              <DiffColumn title="They lose" permissions={diff!.lost} tone="loss" empty="Nothing — this role is strictly wider." />
            </div>

            <details className="rounded-xl border border-border p-3">
              <summary className="cursor-pointer text-xs font-medium">Full {next.name} permissions</summary>
              <RolePermissions effective={next.effective_permissions} className="mt-3" />
            </details>
          </>
        ) : (
          <p className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
            Pick a role to see exactly what changes.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!target || isPending} onClick={() => target && onConfirm(target)}>
            {isPending ? "Applying…" : `Make ${target ?? "…"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DiffColumn({
  title,
  permissions,
  tone,
  empty,
}: {
  title: string;
  permissions: string[];
  tone: "gain" | "loss";
  empty: string;
}) {
  const Icon = tone === "gain" ? Plus : Minus;
  return (
    <div className="rounded-xl border border-border p-3">
      <h4 className="text-xs font-semibold">{title}</h4>
      {permissions.length === 0 ? (
        <p className="mt-1.5 text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="mt-1.5 space-y-1">
          {permissions.map((permission) => (
            <li key={permission} className="flex items-start gap-1.5 text-xs">
              <Icon
                className={cnTone(tone)}
                aria-hidden
              />
              <span>{permissionInfo(permission).label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function cnTone(tone: "gain" | "loss"): string {
  return tone === "gain"
    ? "mt-0.5 size-3 shrink-0 text-status-ok"
    : "mt-0.5 size-3 shrink-0 text-status-bad";
}
