"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, MoreHorizontal, UserPlus } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/shared/error-state";
import { InviteMemberDialog } from "@/components/settings/invite-member-dialog";
import { ChangeRoleDialog } from "@/components/settings/change-role-dialog";
import { membersApi, type AssignableRole, type Member } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";
import {
  blockedReason,
  canInvite,
  canRemove,
  countActiveOwners,
  memberDisplayName,
  memberInitials,
  memberStatusMeta,
  roleBlurb,
  sortMembers,
} from "@/lib/members";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth-store";

function statusFromError(error: unknown): number | undefined {
  return (error as { response?: { status?: number } } | undefined)?.response?.status;
}

/**
 * The organization roster — Vol. 3 §10's "Members" panel.
 *
 * Every rule the row menu enforces (last active Owner, no self-edit, revoke
 * rather than suspend a pending invite) is **also** enforced by `MemberService`
 * and returns a 409 there. The predicates in `lib/members.ts` exist so a
 * refused action is disabled with a reason instead of failing after a click —
 * they are an affordance, never the boundary.
 */
export function MembersCard() {
  const orgId = useAuthStore((state) => state.orgId);
  const queryClient = useQueryClient();
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [roleTarget, setRoleTarget] = React.useState<Member | null>(null);

  const meQuery = useQuery({
    queryKey: ["members", "me", orgId],
    queryFn: () => membersApi.me(),
    enabled: Boolean(orgId),
  });

  const rolesQuery = useQuery({
    queryKey: ["members", "roles", orgId],
    queryFn: () => membersApi.roles(),
    enabled: Boolean(orgId),
    // Roles are seeded system rows; they do not change while a page is open.
    staleTime: Infinity,
    retry: (failureCount, error) => statusFromError(error) !== 403 && failureCount < 2,
  });

  const membersQuery = useQuery({
    queryKey: ["members", orgId],
    queryFn: () => membersApi.list(),
    enabled: Boolean(orgId),
    retry: (failureCount, error) => statusFromError(error) !== 403 && failureCount < 2,
  });

  const me = meQuery.data;
  const members = React.useMemo(() => sortMembers(membersQuery.data ?? []), [membersQuery.data]);
  const activeOwners = countActiveOwners(members);
  const forbidden = membersQuery.isError && statusFromError(membersQuery.error) === 403;

  function onMutationError(error: unknown) {
    toast.error(getApiErrorMessage(error, "That change was refused"));
  }
  function onMutationSuccess(message: string) {
    toast.success(message);
    queryClient.invalidateQueries({ queryKey: ["members"] });
  }

  const roleMutation = useMutation({
    mutationFn: ({ id, role }: { id: string; role: AssignableRole }) => membersApi.changeRole(id, role),
    onSuccess: (member) => {
      onMutationSuccess(`${memberDisplayName(member)} is now ${member.role_name}`);
      setRoleTarget(null);
    },
    onError: onMutationError,
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "active" | "suspended" }) => membersApi.changeStatus(id, status),
    onSuccess: (member) => onMutationSuccess(member.status === "suspended" ? `${memberDisplayName(member)} suspended` : `${memberDisplayName(member)} reactivated`),
    onError: onMutationError,
  });

  const removeMutation = useMutation({
    mutationFn: ({ id }: { id: string; label: string }) => membersApi.remove(id),
    onSuccess: (_data, variables) => onMutationSuccess(`${variables.label} removed`),
    onError: onMutationError,
  });

  if (forbidden) {
    return (
      <Card className="flex min-h-48 flex-col items-center justify-center p-6 text-center">
        <Lock className="size-5 text-muted-foreground" aria-hidden />
        <h3 className="mt-3 text-sm font-semibold">Members are not visible to your role</h3>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          Reading the roster needs <code className="font-mono text-xs">member:read</code>.
        </p>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
        <div>
          <h3 className="text-sm font-semibold">Members</h3>
          <p className="text-xs text-muted-foreground">Who belongs to this organization, and what they can do.</p>
        </div>
        {canInvite(me) ? (
          <Button size="sm" onClick={() => setInviteOpen(true)}>
            <UserPlus className="mr-1.5 size-4" />
            Invite
          </Button>
        ) : null}
      </div>

      {membersQuery.isLoading ? (
        <div className="divide-y divide-border">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="flex items-center gap-3 p-4">
              <Skeleton className="size-9 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56" />
              </div>
              <Skeleton className="h-6 w-20" />
            </div>
          ))}
        </div>
      ) : null}

      {membersQuery.isError && !forbidden ? (
        <div className="p-4">
          <ErrorState message={getApiErrorMessage(membersQuery.error, "Could not load members")} onRetry={() => membersQuery.refetch()} />
        </div>
      ) : null}

      {!membersQuery.isLoading && !membersQuery.isError ? (
        <div className="divide-y divide-border">
          {members.map((member) => (
            <MemberRow
              key={member.id}
              member={member}
              isMe={member.id === me?.membership_id}
              canManageRole={canInvite(me)}
              canManageAccess={canRemove(me)}
              reasonFor={(action) => blockedReason(member, me, activeOwners, action)}
              onRole={() => setRoleTarget(member)}
              onStatus={(status) => statusMutation.mutate({ id: member.id, status })}
              onRemove={() => removeMutation.mutate({ id: member.id, label: memberDisplayName(member) })}
            />
          ))}
        </div>
      ) : null}

      <InviteMemberDialog open={inviteOpen} onOpenChange={setInviteOpen} roles={rolesQuery.data} />
      <ChangeRoleDialog
        // Remount per member: resets the chosen role without an effect.
        key={roleTarget?.id ?? "none"}
        member={roleTarget}
        roles={rolesQuery.data}
        open={roleTarget !== null}
        onOpenChange={(next) => !next && setRoleTarget(null)}
        onConfirm={(role) => roleTarget && roleMutation.mutate({ id: roleTarget.id, role })}
        isPending={roleMutation.isPending}
      />
    </Card>
  );
}

function MemberRow({
  member,
  isMe,
  canManageRole,
  canManageAccess,
  reasonFor,
  onRole,
  onStatus,
  onRemove,
}: {
  member: Member;
  isMe: boolean;
  canManageRole: boolean;
  canManageAccess: boolean;
  reasonFor: (action: "role" | "status" | "remove") => string | null;
  onRole: () => void;
  onStatus: (status: "active" | "suspended") => void;
  onRemove: () => void;
}) {
  const status = memberStatusMeta(member.status);
  const roleReason = reasonFor("role");
  const statusReason = reasonFor("status");
  const removeReason = reasonFor("remove");
  const anyAction = (canManageRole && !roleReason) || (canManageAccess && (!statusReason || !removeReason));

  return (
    <div className="flex flex-wrap items-center gap-3 p-4">
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
          member.status === "invited" ? "bg-muted text-muted-foreground" : "bg-primary/10 text-foreground",
        )}
        aria-hidden
      >
        {memberInitials(member)}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{memberDisplayName(member)}</span>
          {isMe ? <span className="text-xs text-muted-foreground">(you)</span> : null}
          <Badge variant={status.variant} title={status.hint}>
            {status.label}
          </Badge>
        </div>
        <div className="truncate text-xs text-muted-foreground">{member.full_name ? member.email : roleBlurb(member.role_name)}</div>
      </div>

      <div className="text-right">
        <div className="text-sm">{member.role_name}</div>
        <div className="hidden text-xs text-muted-foreground sm:block">{member.status === "invited" ? "on acceptance" : ""}</div>
      </div>

      {anyAction ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={`Actions for ${memberDisplayName(member)}`}>
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {canManageRole ? (
              <>
                {/* One entry, not a list of `Make X`. Changing what a colleague
                    can do to production workflows should not be one unexplained
                    click — the dialog shows what is gained and lost. */}
                {roleReason ? (
                  <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{roleReason}</DropdownMenuLabel>
                ) : (
                  <DropdownMenuItem onSelect={onRole}>Change role…</DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
              </>
            ) : null}

            {canManageAccess ? (
              <>
                {member.status === "active" && !statusReason ? (
                  <DropdownMenuItem onClick={() => onStatus("suspended")}>Suspend access</DropdownMenuItem>
                ) : null}
                {member.status === "suspended" ? <DropdownMenuItem onClick={() => onStatus("active")}>Reactivate</DropdownMenuItem> : null}
                {!removeReason ? (
                  <DropdownMenuItem className="text-destructive" onSelect={onRemove}>
                    {member.status === "invited" ? "Revoke invitation" : "Remove from organization"}
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{removeReason}</DropdownMenuLabel>
                )}
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span className="w-9" aria-hidden />
      )}
    </div>
  );
}
