/**
 * lib/permissions.ts — turning permission strings into something a person can
 * decide with.
 *
 * Pure module (no React, no network), same shape as `lib/members.ts`.
 *
 * ## The wildcard rules are NOT reimplemented here
 *
 * `roles.permissions` stores wildcards — Owner is literally `["*"]`, Viewer
 * `["*:read"]` — and resolving those requires knowing the full vocabulary AND
 * `WILDCARD_READ_EXEMPT`, the set of reads the wildcard deliberately does not
 * reach. That logic lives in ONE place, `core/permissions.expand_permissions`,
 * beside the `permission_granted` it has to agree with, and the API returns the
 * result as `effective_permissions`.
 *
 * So everything below reads `effective_permissions` and never `permissions`. If
 * you find yourself writing `endsWith(":read")` in this file, stop — that is
 * the drift this design exists to prevent.
 */

import type { CurrentMember, RoleOption } from "@/lib/api";

export type PermissionGroup = {
  id: string;
  label: string;
  /** One line on why this group of capabilities hangs together. */
  caption: string;
};

/** Ordered most-everyday first, so the risky groups read as the exceptions. */
export const PERMISSION_GROUPS: readonly PermissionGroup[] = [
  { id: "build", label: "Building", caption: "Designing workflows and the pieces they are made of." },
  { id: "run", label: "Running & approving", caption: "Starting runs, and deciding the approval gates that hold them." },
  { id: "knowledge", label: "Knowledge", caption: "The documents agents answer from." },
  { id: "people", label: "People", caption: "Who is in this organization and what they can do." },
  { id: "governance", label: "Governance & money", caption: "Sensitive by design — credentials, spend and the audit trail." },
];

export type PermissionInfo = {
  /** What it lets you do, in the product's own words — never the raw string. */
  label: string;
  group: PermissionGroup["id"];
  /** True for permissions that change or expose something consequential. */
  sensitive?: boolean;
};

/**
 * The vocabulary, in the order it should be read.
 *
 * Kept in step with `ALL_PERMISSIONS` in `apps/api/src/core/permissions.py`,
 * whose own test asserts that list is complete. A permission missing here still
 * renders — `permissionInfo` derives a label rather than dropping it — because
 * a screen that silently omits a capability under-reports access, which is the
 * one direction it must never be wrong in.
 */
export const PERMISSION_INFO: Record<string, PermissionInfo> = {
  "workflow:read": { label: "View workflows", group: "build" },
  "workflow:write": { label: "Create and edit workflows", group: "build" },
  "workflow:publish": { label: "Publish a version", group: "build", sensitive: true },
  "workspace:read": { label: "View workspaces", group: "build" },
  "workspace:write": { label: "Create and edit workspaces", group: "build" },
  "tool:read": { label: "View the tool registry", group: "build" },
  "tool:write": { label: "Register and edit tools", group: "build", sensitive: true },
  "agent:read": { label: "View agents", group: "build" },
  "agent:write": { label: "Create and edit agents", group: "build" },
  "prompt:read": { label: "View prompts", group: "build" },
  "prompt:write": { label: "Create and edit prompts", group: "build" },

  "workflow:execute": { label: "Trigger runs", group: "run" },
  "execution:read": { label: "View runs and their full timeline", group: "run" },
  "execution:approve": { label: "Approve or reject a paused run", group: "run", sensitive: true },

  "knowledge:read": { label: "Read knowledge bases and search them", group: "knowledge" },
  "knowledge:write": { label: "Upload and delete documents", group: "knowledge" },

  "member:read": { label: "See who is in this organization", group: "people" },
  "member:invite": { label: "Invite members and change their role", group: "people", sensitive: true },
  "member:remove": { label: "Suspend and remove members", group: "people", sensitive: true },

  "integration:read": { label: "See stored credential status", group: "governance", sensitive: true },
  "integration:write": { label: "Store and remove API keys", group: "governance", sensitive: true },
  "billing:read": { label: "View billing", group: "governance", sensitive: true },
  "billing:write": { label: "Change billing", group: "governance", sensitive: true },
  "audit:read": { label: "Read the audit trail, including actor IPs", group: "governance", sensitive: true },
  "org:delete": { label: "Delete this organization", group: "governance", sensitive: true },
};

/** `some:permission` → `Some permission`. The fallback for anything this build
 *  has not heard of — a custom role may name one. */
export function humanizePermission(permission: string): string {
  const words = permission.split(/[:._]/).filter(Boolean).join(" ");
  if (!words) return permission;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function permissionInfo(permission: string): PermissionInfo {
  return PERMISSION_INFO[permission] ?? { label: humanizePermission(permission), group: "governance", sensitive: true };
}

export type GroupedPermissions = {
  group: PermissionGroup;
  granted: string[];
  withheld: string[];
};

/**
 * A role's grant, grouped and paired with what it does NOT include.
 *
 * The withheld half is the point. "Editor can build workflows" is only half an
 * answer to someone assigning a role — the question they are actually asking is
 * "and what can't they do?", and a list of ticks with nothing to contrast
 * against cannot answer it.
 */
export function groupPermissions(effective: readonly string[]): GroupedPermissions[] {
  const granted = new Set(effective);
  const known = Object.keys(PERMISSION_INFO);
  // Anything the API returned that this build does not know about still has to
  // appear, or the screen under-reports the grant.
  const extras = effective.filter((p) => !PERMISSION_INFO[p]);
  const all = [...known, ...extras];

  return PERMISSION_GROUPS.map((group) => {
    const inGroup = all.filter((p) => permissionInfo(p).group === group.id);
    return {
      group,
      granted: inGroup.filter((p) => granted.has(p)),
      withheld: inGroup.filter((p) => !granted.has(p)),
    };
  }).filter((entry) => entry.granted.length > 0 || entry.withheld.length > 0);
}

/** How many of the vocabulary a role holds — the headline on a role card. */
export function grantSummary(effective: readonly string[]): { granted: number; total: number } {
  const extras = effective.filter((p) => !PERMISSION_INFO[p]).length;
  return { granted: effective.length, total: Object.keys(PERMISSION_INFO).length + extras };
}

/**
 * What changes when a member moves from one role to another.
 *
 * Rendered in the change-role dialog so the decision is made against gains and
 * losses rather than against two lists the reader has to diff by eye.
 */
export function roleDiff(from: readonly string[], to: readonly string[]): { gained: string[]; lost: string[] } {
  const fromSet = new Set(from);
  const toSet = new Set(to);
  const order = [...Object.keys(PERMISSION_INFO), ...[...toSet, ...fromSet].filter((p) => !PERMISSION_INFO[p])];
  const seen = new Set<string>();
  const gained: string[] = [];
  const lost: string[] = [];
  for (const p of order) {
    if (seen.has(p)) continue;
    seen.add(p);
    if (toSet.has(p) && !fromSet.has(p)) gained.push(p);
    if (fromSet.has(p) && !toSet.has(p)) lost.push(p);
  }
  return { gained, lost };
}

/** Look a role up by name in whatever `/organizations/roles` returned. */
export function findRole(roles: readonly RoleOption[] | undefined, name: string): RoleOption | undefined {
  return roles?.find((role) => role.name === name);
}

/**
 * Does the caller hold this permission?
 *
 * Reads the API-expanded list, so there is no wildcard branch here at all —
 * that logic was deleted from the frontend when `effective_permissions` landed.
 */
export function callerHas(me: CurrentMember | undefined | null, permission: string): boolean {
  return Boolean(me?.effective_permissions?.includes(permission));
}
