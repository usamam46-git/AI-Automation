import { describe, expect, it } from "vitest";

import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_META,
  auditActionMeta,
  auditActorLabel,
  auditSummary,
  formatIntegrationType,
  formatResourceType,
  humanizeAction,
  nextAuditCursor,
  shortId,
} from "@/lib/audit-log";
import type { AuditLogEntry } from "@/lib/api";

const BASE: AuditLogEntry = {
  id: "11111111-2222-3333-4444-555555555555",
  organization_id: "org-1",
  actor_type: "user",
  actor_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  actor_email: "owner@example.com",
  action: "workflow.published",
  resource_type: "workflow_version",
  resource_id: "ver-1",
  metadata: null,
  ip_address: "203.0.113.7",
  created_at: "2026-08-18T09:15:00.123456+00:00",
};

function entry(patch: Partial<AuditLogEntry>): AuditLogEntry {
  return { ...BASE, ...patch };
}

describe("auditActionMeta", () => {
  it("maps every known action to a label and a badge variant", () => {
    for (const action of AUDIT_ACTIONS) {
      const meta = auditActionMeta(action);
      expect(meta.label).not.toBe("");
      expect(meta.icon).toBeDefined();
    }
  });

  it("keeps AUDIT_ACTIONS and AUDIT_ACTION_META in step", () => {
    // The dropdown offering an action the renderer has no meta for, or vice
    // versa, is the drift this catches.
    expect([...AUDIT_ACTIONS].sort()).toEqual(Object.keys(AUDIT_ACTION_META).sort());
  });

  it("degrades to a derived label for an action it has never seen", () => {
    // The backend vocabulary is open (Vol. 2 §3.5) — this must not throw.
    const meta = auditActionMeta("member.invited");
    expect(meta.label).toBe("Member invited");
    expect(meta.variant).toBe("pending");
  });
});

describe("humanizeAction", () => {
  it("splits on dots and underscores and sentence-cases", () => {
    expect(humanizeAction("workflow.run.quota_exceeded")).toBe("Workflow run quota exceeded");
    expect(humanizeAction("webhook_secret.rotated")).toBe("Webhook secret rotated");
  });

  it("returns the input unchanged when there is nothing to split", () => {
    expect(humanizeAction("")).toBe("");
    expect(humanizeAction("...")).toBe("...");
  });
});

describe("auditActorLabel", () => {
  it("calls the reader's own rows 'You'", () => {
    expect(auditActorLabel(BASE, BASE.actor_id)).toBe("You");
  });

  it("names other people by email", () => {
    expect(auditActorLabel(BASE, "someone-else")).toBe("owner@example.com");
  });

  it("labels system rows 'System' even if an id somehow rides along", () => {
    expect(auditActorLabel(entry({ actor_type: "system", actor_id: null, actor_email: null }), null)).toBe("System");
  });

  it("falls back to a short id, not to 'Unknown', for a user whose email did not resolve", () => {
    // A deleted user is exactly the row an auditor cares most about: the actor
    // IS known, only the name is missing, and those are different claims.
    expect(auditActorLabel(entry({ actor_email: null }), null)).toBe("User aaaaaaaa");
  });

  it("distinguishes an agent actor from a user one", () => {
    expect(auditActorLabel(entry({ actor_type: "agent", actor_email: null }), null)).toBe("Agent aaaaaaaa");
  });
});

describe("auditSummary", () => {
  it("describes a publish from version_number and node_count", () => {
    expect(auditSummary(entry({ metadata: { workflow_id: "wf", version_number: 3, node_count: 6 } }))).toBe("Version 3 · 6 nodes");
  });

  it("singularises a one-node graph", () => {
    expect(auditSummary(entry({ metadata: { version_number: 1, node_count: 1 } }))).toBe("Version 1 · 1 node");
  });

  it("describes an archive with the name and the status it left", () => {
    const row = entry({ action: "workflow.archived", metadata: { name: "Invoice approval", previous_status: "published" } });
    expect(auditSummary(row)).toBe("“Invoice approval” — was published");
  });

  it("names the trigger on a started run", () => {
    expect(auditSummary(entry({ action: "workflow.run.started", metadata: { trigger: "webhook" } }))).toBe("Triggered by webhook");
  });

  it("reports the quota counter as the backend saw it, even above the limit", () => {
    // INCR-then-compare means rejected attempts increment too, so used > limit
    // is a real state. Clamping it would misreport what was enforced.
    const row = entry({ action: "workflow.run.quota_exceeded", metadata: { trigger: "schedule", limit: 1000, used: 1003 } });
    expect(auditSummary(row)).toBe("Blocked at 1003 of 1000 runs today (schedule trigger)");
  });

  it("renders an approval decision with its node and comment", () => {
    const row = entry({ action: "approval.approved", metadata: { decision: "approved", comment: "Checked the MSA", node_key: "approval_1" } });
    expect(auditSummary(row)).toBe("At approval_1 — “Checked the MSA”");
  });

  it("drops a null comment rather than rendering an empty quote", () => {
    const row = entry({ action: "approval.rejected", metadata: { decision: "rejected", comment: null, node_key: "approval_1" } });
    expect(auditSummary(row)).toBe("At approval_1");
  });

  it("distinguishes a stored credential from a replaced one", () => {
    const stored = entry({ action: "integration.credential.set", metadata: { integration_type: "openai_api_key", last_four: "9f2a", replaced_existing: false } });
    const replaced = entry({ action: "integration.credential.set", metadata: { integration_type: "openai_api_key", last_four: "9f2a", replaced_existing: true } });
    expect(auditSummary(stored)).toBe("OpenAI API key ending 9f2a stored");
    expect(auditSummary(replaced)).toBe("OpenAI API key ending 9f2a replaced");
  });

  it("describes a credential deletion", () => {
    const row = entry({ action: "integration.credential.deleted", metadata: { integration_type: "openai_api_key", last_four: "9f2a" } });
    expect(auditSummary(row)).toBe("OpenAI API key ending 9f2a removed");
  });

  it("distinguishes a first webhook secret from a rotation", () => {
    expect(auditSummary(entry({ action: "webhook_secret.rotated", metadata: { replaced_existing: true } }))).toBe("Replaced the previous secret");
    expect(auditSummary(entry({ action: "webhook_secret.rotated", metadata: { replaced_existing: false } }))).toBe("First secret generated");
  });

  it("returns null rather than inventing a sentence when metadata is missing", () => {
    for (const action of AUDIT_ACTIONS) {
      expect(auditSummary(entry({ action, metadata: null }))).toBeNull();
    }
  });

  it("returns null rather than inventing a sentence when metadata is the wrong shape", () => {
    // A version_number arriving as a string is the shape a careless backend
    // change produces; "Version [object Object]" on an audit trail is worse
    // than no summary at all.
    expect(auditSummary(entry({ metadata: { version_number: "3", node_count: {} } }))).toBeNull();
    expect(auditSummary(entry({ action: "workflow.run.started", metadata: { trigger: 7 } }))).toBeNull();
    expect(auditSummary(entry({ action: "webhook_secret.rotated", metadata: { replaced_existing: "yes" } }))).toBeNull();
  });

  it("returns null for an unknown action", () => {
    // `member.invited` used to be the example here and became real on
    // 2026-08-18 — the test caught it. Pick one the backend still does not write.
    expect(auditSummary(entry({ action: "api_key.created", metadata: { last_four: "1234" } }))).toBeNull();
  });

  it("describes the member lifecycle", () => {
    const invited = entry({ action: "member.invited", metadata: { email: "new@example.com", role: "Editor", existing_account: false } });
    expect(auditSummary(invited)).toBe("new@example.com invited as Editor");

    const accepted = entry({ action: "member.invitation_accepted", metadata: { email: "new@example.com", role: "Editor" } });
    expect(auditSummary(accepted)).toBe("new@example.com joined as Editor");

    const role = entry({ action: "member.role_changed", metadata: { email: "new@example.com", from: "Editor", to: "Admin" } });
    expect(auditSummary(role)).toBe("new@example.com: Editor → Admin");

    const suspended = entry({ action: "member.status_changed", metadata: { email: "new@example.com", from: "active", to: "suspended" } });
    expect(auditSummary(suspended)).toBe("new@example.com: active → suspended");

    const removed = entry({ action: "member.removed", metadata: { email: "new@example.com", role: "Admin", was_status: "active" } });
    expect(auditSummary(removed)).toBe("new@example.com (Admin) removed");
  });

  it("never renders an invitation token, even if one were recorded", () => {
    // The service does not put the accept URL in metadata, and a test in
    // tests/test_members.py pins that. This is the second line of defence: even
    // handed one, the renderer reads only the keys it knows about.
    const row = entry({ action: "member.invited", metadata: { email: "x@y.z", role: "Viewer", token: "eyJhbGciOi.SECRET.sig" } });
    expect(auditSummary(row)).toBe("x@y.z invited as Viewer");
    expect(auditSummary(row)).not.toContain("SECRET");
  });
});

describe("formatters", () => {
  it("formats a resource type", () => {
    expect(formatResourceType("workflow_version")).toBe("Workflow version");
    expect(formatResourceType("workflow_run")).toBe("Workflow run");
  });

  it("spells the one real integration type properly", () => {
    expect(formatIntegrationType("openai_api_key")).toBe("OpenAI API key");
    expect(formatIntegrationType("slack_webhook")).toBe("Slack webhook");
  });

  it("shortens a uuid to its first segment", () => {
    expect(shortId("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBe("aaaaaaaa");
    expect(shortId("not-a-uuid")).toBe("not");
  });
});

describe("nextAuditCursor", () => {
  it("returns the last row's raw created_at when the page was full", () => {
    const rows = [entry({ id: "a" }), entry({ id: "b", created_at: "2026-08-18T08:00:00.000001+00:00" })];
    expect(nextAuditCursor(rows, 2)).toBe("2026-08-18T08:00:00.000001+00:00");
  });

  it("passes the timestamp through untouched, keeping microsecond precision", () => {
    // A round-trip through JS Date truncates to milliseconds, and the backend
    // compares `created_at < cursor` — losing the microseconds re-serves the
    // boundary row on every page.
    const rows = [entry({ created_at: "2026-08-18T09:15:00.123456+00:00" })];
    expect(nextAuditCursor(rows, 1)).toBe("2026-08-18T09:15:00.123456+00:00");
  });

  it("returns null on a short page — there is nothing more to ask for", () => {
    expect(nextAuditCursor([entry({})], 50)).toBeNull();
    expect(nextAuditCursor([], 50)).toBeNull();
  });
});
