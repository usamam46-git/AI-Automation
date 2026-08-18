import { describe, expect, it } from "vitest";

import {
  PERMISSION_GROUPS,
  PERMISSION_INFO,
  callerHas,
  findRole,
  grantSummary,
  groupPermissions,
  humanizePermission,
  permissionInfo,
  roleDiff,
} from "@/lib/permissions";
import type { CurrentMember, RoleOption } from "@/lib/api";

const EDITOR = [
  "workflow:read",
  "workflow:write",
  "workspace:read",
  "workspace:write",
  "agent:read",
  "agent:write",
  "prompt:read",
  "prompt:write",
  "tool:read",
  "tool:write",
  "knowledge:read",
  "knowledge:write",
  "member:read",
];

const APPROVER = ["execution:read", "execution:approve", "member:read"];

describe("PERMISSION_INFO", () => {
  it("puts every permission in a real group", () => {
    const groupIds = new Set(PERMISSION_GROUPS.map((g) => g.id));
    for (const [permission, info] of Object.entries(PERMISSION_INFO)) {
      expect(groupIds.has(info.group), `${permission} → ${info.group}`).toBe(true);
      expect(info.label).not.toBe("");
      // A raw string leaking into the UI is the thing this map exists to stop.
      expect(info.label).not.toContain(":");
    }
  });

  it("marks the governance permissions sensitive", () => {
    for (const p of ["integration:write", "billing:write", "audit:read", "org:delete"]) {
      expect(permissionInfo(p).sensitive).toBe(true);
    }
    expect(permissionInfo("workflow:read").sensitive).toBeFalsy();
  });
});

describe("permissionInfo", () => {
  it("derives a label for a permission this build has never seen", () => {
    // A custom role (Vol. 2 §658) can name one. Dropping it would under-report
    // the grant, which is the one direction this screen must not be wrong in.
    const info = permissionInfo("reporting:export");
    expect(info.label).toBe("Reporting export");
    expect(info.sensitive).toBe(true);
  });

  it("humanizes on any separator", () => {
    expect(humanizePermission("workflow:publish")).toBe("Workflow publish");
    expect(humanizePermission("member.role_changed")).toBe("Member role changed");
    expect(humanizePermission("")).toBe("");
  });
});

describe("groupPermissions", () => {
  it("splits each group into granted and withheld", () => {
    const groups = groupPermissions(APPROVER);
    const run = groups.find((g) => g.group.id === "run")!;
    expect(run.granted).toContain("execution:approve");
    // The withheld half is the point — "what can't they do" is the actual
    // question someone assigning a role is asking.
    expect(run.withheld).toContain("workflow:execute");

    const governance = groups.find((g) => g.group.id === "governance")!;
    expect(governance.granted).toEqual([]);
    expect(governance.withheld.length).toBeGreaterThan(0);
  });

  it("keeps the declared group order", () => {
    const ids = groupPermissions(EDITOR).map((g) => g.group.id);
    expect(ids).toEqual(PERMISSION_GROUPS.filter((g) => ids.includes(g.id)).map((g) => g.id));
  });

  it("shows a permission it does not recognise rather than dropping it", () => {
    const groups = groupPermissions([...APPROVER, "reporting:export"]);
    const all = groups.flatMap((g) => g.granted);
    expect(all).toContain("reporting:export");
  });

  it("handles an empty grant without inventing groups", () => {
    const groups = groupPermissions([]);
    expect(groups.every((g) => g.granted.length === 0)).toBe(true);
    expect(groups.length).toBeGreaterThan(0);
  });
});

describe("grantSummary", () => {
  it("counts the grant against the vocabulary", () => {
    const { granted, total } = grantSummary(APPROVER);
    expect(granted).toBe(3);
    expect(total).toBe(Object.keys(PERMISSION_INFO).length);
  });

  it("widens the total when an unknown permission is held", () => {
    const { granted, total } = grantSummary([...APPROVER, "reporting:export"]);
    expect(granted).toBe(4);
    expect(total).toBe(Object.keys(PERMISSION_INFO).length + 1);
  });
});

describe("roleDiff", () => {
  it("reports what is gained and what is lost", () => {
    const { gained, lost } = roleDiff(EDITOR, APPROVER);
    expect(gained).toContain("execution:approve");
    expect(lost).toContain("workflow:write");
    expect(lost).toContain("knowledge:write");
    // Held by both — must appear in neither list.
    expect(gained).not.toContain("member:read");
    expect(lost).not.toContain("member:read");
  });

  it("is empty for an unchanged role", () => {
    expect(roleDiff(EDITOR, EDITOR)).toEqual({ gained: [], lost: [] });
  });

  it("is not symmetric", () => {
    const forward = roleDiff(EDITOR, APPROVER);
    const back = roleDiff(APPROVER, EDITOR);
    expect(forward.gained).toEqual(back.lost);
    expect(forward.lost).toEqual(back.gained);
  });

  it("includes unrecognised permissions on both sides", () => {
    const { gained, lost } = roleDiff(["reporting:export"], ["reporting:import"]);
    expect(gained).toEqual(["reporting:import"]);
    expect(lost).toEqual(["reporting:export"]);
  });
});

describe("callerHas", () => {
  function me(effective: string[]): CurrentMember {
    return {
      membership_id: "m",
      user_id: "u",
      email: "a@b.c",
      role_name: "Admin",
      permissions: ["*"],
      effective_permissions: effective,
      status: "active",
    };
  }

  it("reads only the expanded list", () => {
    expect(callerHas(me(["audit:read"]), "audit:read")).toBe(true);
    // permissions is ["*"] and must not be consulted.
    expect(callerHas(me(["audit:read"]), "billing:write")).toBe(false);
    expect(callerHas(undefined, "audit:read")).toBe(false);
  });
});

describe("findRole", () => {
  const roles: RoleOption[] = [
    { id: "1", name: "Editor", permissions: [], effective_permissions: EDITOR, assignable: true },
    { id: "2", name: "Approver", permissions: [], effective_permissions: APPROVER, assignable: true },
    { id: "3", name: "Owner", permissions: ["*"], effective_permissions: Object.keys(PERMISSION_INFO), assignable: false },
  ];

  it("finds by name and tolerates an unloaded list", () => {
    expect(findRole(roles, "Approver")?.id).toBe("2");
    expect(findRole(roles, "Nonexistent")).toBeUndefined();
    expect(findRole(undefined, "Editor")).toBeUndefined();
  });

  it("finds Owner, which is listed for reference but not assignable", () => {
    // Dropdowns filter on the flag; the reference table does not. Losing the
    // Owner row would answer "who can do X" wrongly.
    const owner = findRole(roles, "Owner");
    expect(owner?.assignable).toBe(false);
    expect(roles.filter((r) => r.assignable).map((r) => r.name)).toEqual(["Editor", "Approver"]);
  });
});
