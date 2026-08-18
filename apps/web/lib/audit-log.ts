/**
 * lib/audit-log.ts — how an audit row reads.
 *
 * Pure module (no React, no network) so it stays vitest-covered, same shape as
 * `lib/run-status.ts` and `lib/approval-summary.ts`.
 *
 * The endpoint has existed since 2026-08-09 with zero consumers; this is the
 * translation layer between what `AuditService.record()` writes and what a
 * person reading a governance screen needs to see. Three jobs:
 *
 *   1. `auditActionMeta` — an action string becomes a label, a badge variant
 *      and an icon. The vocabulary is open (Vol. 2 §3.5 documents `action` as a
 *      free-text dot-separated namespace, and `AuditAction` is a class of
 *      string constants precisely so a new action needs no migration), so this
 *      **must** degrade gracefully rather than throw on an action it has never
 *      seen — see `humanizeAction`.
 *   2. `auditActorLabel` — `actor_id` is a bare UUID. `actor_email` resolves it
 *      for user rows; agent and system rows have none by construction.
 *   3. `auditSummary` — one sentence built from `metadata`.
 *
 * ## The summary must never invent a fact
 *
 * The same rule `approval-summary.ts` follows, and for the same reason: this
 * screen exists to be trusted. Every branch below reads values that the
 * corresponding `AuditService.record()` call site actually writes, and returns
 * `null` when the metadata is absent or the wrong shape. A plausible-looking
 * sentence assembled from a guess is worse on an audit trail than no sentence.
 *
 * It is also the reason nothing here formats a secret: the credential actions
 * record `integration_type` + `last_four` and the webhook rotation records only
 * `replaced_existing`, so there is nothing sensitive to leak — but if a call
 * site ever starts recording more, this file must not start rendering it.
 */

import {
  Archive,
  Ban,
  CircleCheck,
  CircleSlash,
  GitCommitVertical,
  KeyRound,
  Play,
  RotateCcwKey,
  ScrollText,
  Trash2,
  UserCheck,
  UserCog,
  UserMinus,
  UserPlus,
  type LucideIcon,
} from "lucide-react";

import type { AuditLogEntry } from "@/lib/api";

/** Badge variant names that already exist in components/ui/badge.tsx's cva.
 *  Audit rows deliberately reuse the product's one status vocabulary (Vol. 3
 *  §5) rather than forking a parallel palette. */
export type AuditVariant = "published" | "archived" | "running" | "failed" | "completed" | "rejected" | "mutating" | "pending";

export type AuditActionMeta = {
  label: string;
  variant: AuditVariant;
  icon: LucideIcon;
};

/**
 * The nine actions something in the backend actually writes, as of 2026-08-18.
 *
 * Kept in step with `AuditAction` in `apps/api/src/modules/audit_logs/service.py`,
 * whose docstring makes the same promise in the other direction: only actions
 * that are really written are listed, because an entry here that nothing emits
 * reads as coverage that does not exist. An action missing from this map still
 * renders — it just gets a derived label.
 *
 * **Icon choices are literal, not decorative.** `workflow.published` used to be
 * a rocket; publishing here is an immutable version being cut, and a launch
 * glyph oversells it in a way that reads as stock-AI dressing rather than as a
 * record. `GitCommitVertical` says the true thing. Same reasoning put a
 * rotation on `webhook_secret.rotated` instead of a second key. If a glyph here
 * could sit on any product's screen unchanged, it is the wrong glyph.
 */
export const AUDIT_ACTION_META: Record<string, AuditActionMeta> = {
  "workflow.published": { label: "Version published", variant: "published", icon: GitCommitVertical },
  "workflow.archived": { label: "Workflow archived", variant: "archived", icon: Archive },
  "workflow.run.started": { label: "Run started", variant: "running", icon: Play },
  "workflow.run.quota_exceeded": { label: "Run quota exceeded", variant: "failed", icon: Ban },
  "approval.approved": { label: "Approval granted", variant: "completed", icon: CircleCheck },
  "approval.rejected": { label: "Approval rejected", variant: "rejected", icon: CircleSlash },
  "integration.credential.set": { label: "Credential stored", variant: "mutating", icon: KeyRound },
  "integration.credential.deleted": { label: "Credential removed", variant: "mutating", icon: Trash2 },
  "webhook_secret.rotated": { label: "Webhook secret rotated", variant: "mutating", icon: RotateCcwKey },
  "member.invited": { label: "Member invited", variant: "pending", icon: UserPlus },
  "member.invitation_accepted": { label: "Invitation accepted", variant: "completed", icon: UserCheck },
  "member.role_changed": { label: "Role changed", variant: "mutating", icon: UserCog },
  "member.status_changed": { label: "Access changed", variant: "mutating", icon: UserCog },
  "member.removed": { label: "Member removed", variant: "rejected", icon: UserMinus },
};

/** The filter dropdown's options, in the order they read best: the workflow
 *  lifecycle, then the approval decisions, then the credential events. */
export const AUDIT_ACTIONS: readonly string[] = [
  "workflow.published",
  "workflow.archived",
  "workflow.run.started",
  "workflow.run.quota_exceeded",
  "approval.approved",
  "approval.rejected",
  "integration.credential.set",
  "integration.credential.deleted",
  "webhook_secret.rotated",
  "member.invited",
  "member.invitation_accepted",
  "member.role_changed",
  "member.status_changed",
  "member.removed",
];

/**
 * `some.namespaced.action` → `Some namespaced action`.
 *
 * The fallback for an action this build has never heard of. It exists because
 * the backend vocabulary is open by design, and a governance screen that
 * renders a blank row (or crashes) the first time someone adds an action is
 * worse than one that shows a slightly awkward label.
 */
export function humanizeAction(action: string): string {
  const words = action.split(/[._]/).filter(Boolean).join(" ");
  if (!words) return action;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function auditActionMeta(action: string): AuditActionMeta {
  return AUDIT_ACTION_META[action] ?? { label: humanizeAction(action), variant: "pending", icon: ScrollText };
}

/**
 * Who did it.
 *
 * `currentUserId` turns the reader's own rows into "You", which is what makes a
 * trail scannable — the rest are addresses. A user row with no resolved email
 * falls back to a short id rather than to "Unknown": the actor is known, it is
 * the *name* that could not be resolved, and those are different claims. That
 * happens when the user has since been deleted, which is exactly the row an
 * auditor cares most about.
 */
export function auditActorLabel(entry: AuditLogEntry, currentUserId?: string | null): string {
  if (entry.actor_type === "system") return "System";
  if (currentUserId && entry.actor_id === currentUserId) return "You";
  if (entry.actor_email) return entry.actor_email;
  if (entry.actor_type === "agent") return entry.actor_id ? `Agent ${shortId(entry.actor_id)}` : "Agent";
  return entry.actor_id ? `User ${shortId(entry.actor_id)}` : "Unknown actor";
}

/** First segment of a UUID. Enough to correlate two rows by eye, short enough
 *  not to dominate a table cell. */
export function shortId(id: string): string {
  return id.split("-")[0] ?? id;
}

/** `workflow_version` → `Workflow version`. The column is free-text on the
 *  backend, so this is a formatter, not a lookup. */
export function formatResourceType(resourceType: string): string {
  return humanizeAction(resourceType);
}

/* -------------------------------------------------------------------------- */
/* Summaries                                                                    */
/* -------------------------------------------------------------------------- */

function str(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function num(metadata: Record<string, unknown> | null | undefined, key: string): number | null {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(metadata: Record<string, unknown> | null | undefined, key: string): boolean | null {
  const value = metadata?.[key];
  return typeof value === "boolean" ? value : null;
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

/**
 * One sentence describing what the row's `metadata` says, or `null` when the
 * metadata cannot support one.
 *
 * Null is a first-class result and the caller renders nothing — never a
 * placeholder sentence. See the module docstring.
 */
export function auditSummary(entry: AuditLogEntry): string | null {
  const meta = entry.metadata ?? null;

  switch (entry.action) {
    case "workflow.published": {
      const version = num(meta, "version_number");
      const nodes = num(meta, "node_count");
      const parts: string[] = [];
      if (version !== null) parts.push(`Version ${version}`);
      if (nodes !== null) parts.push(plural(nodes, "node"));
      return parts.length ? parts.join(" · ") : null;
    }

    case "workflow.archived": {
      const name = str(meta, "name");
      const previous = str(meta, "previous_status");
      if (name && previous) return `“${name}” — was ${previous}`;
      return name ?? (previous ? `Was ${previous}` : null);
    }

    case "workflow.run.started": {
      const trigger = str(meta, "trigger");
      return trigger ? `Triggered by ${trigger}` : null;
    }

    case "workflow.run.quota_exceeded": {
      const used = num(meta, "used");
      const limit = num(meta, "limit");
      const trigger = str(meta, "trigger");
      if (used === null || limit === null) return trigger ? `Blocked — ${trigger} trigger` : null;
      const suffix = trigger ? ` (${trigger} trigger)` : "";
      // "used" can legitimately exceed "limit": the quota counter is
      // INCR-then-compare, so rejected attempts increment too. Rendered as-is
      // rather than clamped — the counter is what the backend acted on.
      return `Blocked at ${used} of ${limit} runs today${suffix}`;
    }

    case "approval.approved":
    case "approval.rejected": {
      const node = str(meta, "node_key");
      const comment = str(meta, "comment");
      const at = node ? `At ${node}` : null;
      if (at && comment) return `${at} — “${comment}”`;
      return comment ? `“${comment}”` : at;
    }

    case "integration.credential.set": {
      const type = str(meta, "integration_type");
      const lastFour = str(meta, "last_four");
      const replaced = bool(meta, "replaced_existing");
      // Nothing recorded means nothing to say. "Credential stored" reads like a
      // fact read off the row when it would in fact be read off the action name
      // the badge already carries.
      if (type === null && lastFour === null && replaced === null) return null;
      const subject = type ? formatIntegrationType(type) : "Credential";
      const tail = lastFour ? ` ending ${lastFour}` : "";
      return `${subject}${tail} ${replaced ? "replaced" : "stored"}`;
    }

    case "integration.credential.deleted": {
      const type = str(meta, "integration_type");
      const lastFour = str(meta, "last_four");
      if (type === null && lastFour === null) return null;
      const subject = type ? formatIntegrationType(type) : "Credential";
      return `${subject}${lastFour ? ` ending ${lastFour}` : ""} removed`;
    }

    case "webhook_secret.rotated": {
      const replaced = bool(meta, "replaced_existing");
      if (replaced === null) return null;
      return replaced ? "Replaced the previous secret" : "First secret generated";
    }

    case "member.invited": {
      const email = str(meta, "email");
      const role = str(meta, "role");
      if (!email) return role ? `Invited as ${role}` : null;
      return role ? `${email} invited as ${role}` : `${email} invited`;
    }

    case "member.invitation_accepted": {
      const email = str(meta, "email");
      const role = str(meta, "role");
      if (!email) return null;
      return role ? `${email} joined as ${role}` : `${email} joined`;
    }

    case "member.role_changed":
    case "member.status_changed": {
      const email = str(meta, "email");
      const from = str(meta, "from");
      const to = str(meta, "to");
      if (!from || !to) return email;
      return email ? `${email}: ${from} → ${to}` : `${from} → ${to}`;
    }

    case "member.removed": {
      const email = str(meta, "email");
      const role = str(meta, "role");
      if (!email) return null;
      return role ? `${email} (${role}) removed` : `${email} removed`;
    }

    default:
      return null;
  }
}

/** `openai_api_key` → `OpenAI API key`. Only one integration type is real
 *  (Vol. 2 §13); anything else falls through to the generic formatter rather
 *  than being special-cased ahead of existing. */
export function formatIntegrationType(type: string): string {
  if (type === "openai_api_key") return "OpenAI API key";
  return humanizeAction(type);
}

/**
 * The cursor for the next page: the raw ISO `created_at` of the last row.
 *
 * Raw, not re-serialized through `Date` — the backend parses it with
 * `datetime.fromisoformat` and compares `created_at <` it, and a round-trip
 * through JS `Date` loses sub-millisecond precision, which would re-serve the
 * boundary row on every page. Same convention as the Workflows and Executions
 * lists. `null` means there is no next page to ask for.
 */
export function nextAuditCursor(entries: readonly AuditLogEntry[], pageSize: number): string | null {
  if (entries.length < pageSize || entries.length === 0) return null;
  return entries[entries.length - 1]?.created_at ?? null;
}
