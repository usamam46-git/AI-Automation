/**
 * lib/members.ts — how a roster row reads, and what the caller may do to it.
 *
 * Pure module (no React, no network), same shape as `lib/audit-log.ts`.
 *
 * ## The permission predicates are a UX affordance, NOT a security boundary
 *
 * Every rule below is enforced by `MemberService` on the backend and returns a
 * 409 or 403 there. This file exists so a button that would be refused is
 * disabled with a reason instead of failing after a click. If the two ever
 * disagree, the backend wins and the user sees an error toast — which is
 * degraded, not unsafe. Never move a rule OUT of the service and into here.
 */

import type { CurrentMember, Member, MemberStatus } from "@/lib/api";

export type MemberStatusMeta = {
  label: string;
  /** Badge variant name — must exist in components/ui/badge.tsx's cva. */
  variant: "completed" | "waiting_approval" | "cancelled";
  hint: string;
};

export const MEMBER_STATUS_META: Record<MemberStatus, MemberStatusMeta> = {
  active: { label: "Active", variant: "completed", hint: "Can sign in and use this organization." },
  invited: { label: "Invited", variant: "waiting_approval", hint: "Has not accepted yet. Grants nothing until they do." },
  suspended: { label: "Suspended", variant: "cancelled", hint: "Blocked from this organization; their account still exists." },
};

export function memberStatusMeta(status: MemberStatus | string): MemberStatusMeta {
  return MEMBER_STATUS_META[status as MemberStatus] ?? { label: status, variant: "cancelled", hint: "" };
}

/** What a role can do, in one line, for the assignment dropdown. */
export const ROLE_BLURBS: Record<string, string> = {
  Owner: "Everything, including billing, BYOK keys and this member list.",
  Admin: "Everything except billing and stored credentials.",
  Editor: "Build and edit workflows, tools and knowledge bases. Cannot publish or approve.",
  Approver: "Read runs and decide approval gates. Cannot edit anything.",
  Viewer: "Read-only. Cannot see credentials or the audit log.",
};

export function roleBlurb(roleName: string): string {
  return ROLE_BLURBS[roleName] ?? "";
}

/** Display name, falling back to the address a pending invite was sent to. */
export function memberDisplayName(member: Member): string {
  return member.full_name?.trim() || member.email;
}

/** Two-letter avatar initials. Falls back to the email's first character. */
export function memberInitials(member: Member): string {
  const name = member.full_name?.trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  }
  return (member.email[0] ?? "?").toUpperCase();
}

/** True when this row is the signed-in user's own membership. */
export function isSelf(member: Member, me: CurrentMember | undefined | null): boolean {
  return Boolean(me && member.id === me.membership_id);
}

/**
 * Does the caller hold this permission?
 *
 * Reads `effective_permissions`, which the backend produces with
 * `expand_permissions` — so there is **no wildcard branch here**. There used to
 * be one, mirroring the backend's, and it could only ever be asked about
 * `member:*` because reproducing `WILDCARD_READ_EXEMPT` in a second language
 * would have been a copy that drifts. Expanding server-side removed the problem
 * rather than containing it.
 */
export function hasPermission(me: CurrentMember | undefined | null, permission: string): boolean {
  return Boolean(me?.effective_permissions?.includes(permission));
}

export const canInvite = (me: CurrentMember | undefined | null) => hasPermission(me, "member:invite");
export const canRemove = (me: CurrentMember | undefined | null) => hasPermission(me, "member:remove");

/**
 * Why a member's controls are disabled, or `null` when they are usable.
 *
 * `activeOwnerCount` comes from the roster the caller already has, so the
 * last-Owner rule can be shown before it is hit rather than discovered as a 409.
 */
export function blockedReason(
  member: Member,
  me: CurrentMember | undefined | null,
  activeOwnerCount: number,
  action: "role" | "status" | "remove",
): string | null {
  if (isSelf(member, me)) {
    return action === "role" ? "You cannot change your own role" : "You cannot remove or suspend yourself";
  }
  if (member.role_name === "Owner" && member.status === "active" && activeOwnerCount <= 1) {
    return "The last active Owner cannot be changed — the organization would have nobody able to manage it";
  }
  if (action === "status" && member.status === "invited") {
    return "This invitation has not been accepted yet — revoke it instead";
  }
  if (action === "role" && member.role_name === "Owner") {
    // The API's ASSIGNABLE_ROLES excludes Owner in both directions: ownership
    // transfer is a separate, unbuilt operation.
    return "Changing an Owner's role is not supported yet";
  }
  return null;
}

export function countActiveOwners(members: readonly Member[]): number {
  return members.filter((m) => m.role_name === "Owner" && m.status === "active").length;
}

/** Pending invitations first — they are the rows that need an action. The
 *  backend already orders this way; sorting again keeps an optimistically
 *  updated cache in the same order. */
export function sortMembers(members: readonly Member[]): Member[] {
  return [...members].sort((a, b) => {
    if ((a.status === "invited") !== (b.status === "invited")) return a.status === "invited" ? -1 : 1;
    return Date.parse(a.created_at) - Date.parse(b.created_at);
  });
}
