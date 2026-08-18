"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { auditActionMeta, auditActorLabel, auditSummary, formatResourceType, shortId } from "@/lib/audit-log";
import type { AuditLogEntry } from "@/lib/api";

/** Shared with the page's column header so the two cannot drift. */
export const AUDIT_GRID = "sm:grid-cols-[1.7fr_1fr_1fr_0.75fr_0.85fr]";

/**
 * One audit event.
 *
 * Expands to the raw row rather than to a prettier summary. On a governance
 * screen the underlying record IS the product — an auditor's next question
 * after "what happened" is "show me what you actually stored" — so the
 * disclosure shows the verbatim `metadata` JSON plus the full ids that the
 * collapsed row abbreviates.
 */
export function AuditLogRow({ entry, currentUserId }: { entry: AuditLogEntry; currentUserId?: string | null }) {
  const [open, setOpen] = React.useState(false);
  const meta = auditActionMeta(entry.action);
  const Icon = meta.icon;
  const summary = auditSummary(entry);
  const actor = auditActorLabel(entry, currentUserId);

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn("grid w-full gap-2 p-3 text-left text-sm transition-colors hover:bg-muted/40 sm:items-center sm:gap-3", AUDIT_GRID)}
      >
        <div className="flex min-w-0 items-start gap-2">
          <ChevronRight className={cn("mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden />
          <div className="min-w-0">
            <Badge variant={meta.variant} className="gap-1">
              <Icon className="size-3" />
              {meta.label}
            </Badge>
            {/* Null summary renders nothing at all — never a placeholder
                sentence. See the rule in lib/audit-log.ts. */}
            {summary ? <div className="mt-1 truncate text-xs text-muted-foreground">{summary}</div> : null}
          </div>
        </div>

        <div className="min-w-0 truncate text-muted-foreground" title={entry.actor_email ?? entry.actor_id ?? undefined}>
          {actor}
        </div>

        <div className="min-w-0 text-muted-foreground">
          <div className="truncate">{formatResourceType(entry.resource_type)}</div>
          {entry.resource_id ? <div className="truncate font-mono text-xs text-muted-foreground/70">{shortId(entry.resource_id)}</div> : null}
        </div>

        {/* Forensic hint only. `client_ip()` prefers the leftmost
            X-Forwarded-For hop, which any caller can forge — it must never be
            presented as proof of origin, so it sits in the quietest column. */}
        <div className="truncate font-mono text-xs text-muted-foreground/70">{entry.ip_address ?? "—"}</div>

        <div className="text-muted-foreground">{new Date(entry.created_at).toLocaleString()}</div>
      </button>

      {open ? (
        <div className="grid gap-3 border-t border-border/60 bg-muted/20 px-3 py-3 text-xs sm:grid-cols-2">
          <dl className="space-y-1.5">
            <Field label="Event id" value={entry.id} mono />
            <Field label="Action" value={entry.action} mono />
            <Field label="Actor type" value={entry.actor_type} />
            <Field label="Actor id" value={entry.actor_id ?? "—"} mono />
            <Field label="Resource" value={`${entry.resource_type} · ${entry.resource_id ?? "—"}`} mono />
            <Field label="Recorded at" value={entry.created_at} mono />
          </dl>
          <div>
            <div className="mb-1 font-medium text-muted-foreground">metadata</div>
            <pre className="max-h-56 overflow-auto rounded-lg border border-border bg-background p-2 font-mono text-[11px] leading-relaxed">
              {entry.metadata ? JSON.stringify(entry.metadata, null, 2) : "null"}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 break-all", mono && "font-mono")}>{value}</dd>
    </div>
  );
}
