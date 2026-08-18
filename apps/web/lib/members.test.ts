import { describe, expect, it } from "vitest";

import {
  blockedReason,
  canInvite,
  canRemove,
  countActiveOwners,
  hasPermission,
  isSelf,
  memberDisplayName,
  memberInitials,
  memberStatusMeta,
  roleBlurb,
  sortMembers,
} from "@/lib/members";
import type { CurrentMember, Member } from "@/lib/api";

function member(patch: Partial<Member> = {}): Member {
  return {
    id: "m-1",
    user_id: "u-1",
    email: "person@example.com",
    full_name: "Ada Lovelace",
    role_id: "r-1",
    role_name: "Editor",
    status: "active",
    created_at: "2026-08-18T09:00:00Z",
    ...patch,
  };
}

function me(patch: Partial<CurrentMember> = {}): CurrentMember {
  return {
    membership_id: "m-owner",
    user_id: "u-owner",
    email: "owner@example.com",
    role_name: "Owner",
    permissions: ["*"],
    effective_permissions: ["member:read", "member:invite", "member:remove", "workflow:read", "audit:read"],
    status: "active",
    ...patch,
  };
}

describe("hasPermission", () => {
  it("reads the backend-expanded list, not the stored wildcards", () => {
    // The whole point: `permissions` still says ["*"], and this helper must not
    // care. Expansion happens once, server-side, in expand_permissions().
    const owner = me({ permissions: ["*"], effective_permissions: ["member:invite"] });
    expect(hasPermission(owner, "member:invite")).toBe(true);
    expect(hasPermission(owner, "billing:write")).toBe(false);
  });

  it("honours an explicit grant", () => {
    const admin = me({ role_name: "Admin", effective_permissions: ["member:read", "member:invite"] });
    expect(hasPermission(admin, "member:invite")).toBe(true);
    expect(hasPermission(admin, "member:remove")).toBe(false);
  });

  it("does not resolve a wildcard itself", () => {
    // A raw "*:read" reaching this helper means the API contract broke. Better
    // to deny and show a locked state than to guess which reads it covers —
    // guessing is exactly what WILDCARD_READ_EXEMPT makes unsafe.
    const broken = me({ role_name: "Viewer", permissions: ["*:read"], effective_permissions: ["*:read"] });
    expect(hasPermission(broken, "member:read")).toBe(false);
  });

  it("grants nothing when the caller is unknown", () => {
    expect(hasPermission(undefined, "member:read")).toBe(false);
    expect(canInvite(null)).toBe(false);
    expect(canRemove(undefined)).toBe(false);
  });
});

describe("blockedReason", () => {
  it("stops you editing yourself", () => {
    const self = member({ id: "m-owner" });
    expect(blockedReason(self, me(), 2, "role")).toMatch(/your own role/);
    expect(blockedReason(self, me(), 2, "remove")).toMatch(/yourself/);
  });

  it("protects the last active Owner", () => {
    const owner = member({ id: "m-2", role_name: "Owner", status: "active" });
    expect(blockedReason(owner, me(), 1, "remove")).toMatch(/last active Owner/);
    expect(blockedReason(owner, me(), 1, "status")).toMatch(/last active Owner/);
  });

  it("still refuses an Owner role change even when another Owner exists", () => {
    // Ownership transfer is a separate, unbuilt operation — the backend's
    // ASSIGNABLE_ROLES excludes Owner in both directions.
    const owner = member({ id: "m-2", role_name: "Owner", status: "active" });
    expect(blockedReason(owner, me(), 2, "role")).toMatch(/not supported yet/);
  });

  it("allows removing a non-last Owner", () => {
    const owner = member({ id: "m-2", role_name: "Owner", status: "active" });
    expect(blockedReason(owner, me(), 2, "remove")).toBeNull();
  });

  it("says to revoke a pending invitation rather than suspend it", () => {
    const invited = member({ id: "m-3", status: "invited", user_id: null });
    expect(blockedReason(invited, me(), 2, "status")).toMatch(/revoke it instead/);
    // Revoking one IS allowed — that is what DELETE does.
    expect(blockedReason(invited, me(), 2, "remove")).toBeNull();
  });

  it("allows an ordinary member to be edited", () => {
    expect(blockedReason(member({ id: "m-9" }), me(), 2, "role")).toBeNull();
    expect(blockedReason(member({ id: "m-9" }), me(), 2, "remove")).toBeNull();
  });
});

describe("isSelf", () => {
  it("compares membership ids, not user ids", () => {
    // A pending invitation has a null user_id, so a user_id comparison would
    // match every pending row against every other.
    expect(isSelf(member({ id: "m-owner", user_id: null }), me())).toBe(true);
    expect(isSelf(member({ id: "m-2", user_id: null }), me())).toBe(false);
  });

  it("is false when the caller is unknown", () => {
    expect(isSelf(member(), undefined)).toBe(false);
  });
});

describe("countActiveOwners", () => {
  it("counts only active Owners", () => {
    const rows = [
      member({ id: "1", role_name: "Owner", status: "active" }),
      member({ id: "2", role_name: "Owner", status: "suspended" }),
      member({ id: "3", role_name: "Owner", status: "invited" }),
      member({ id: "4", role_name: "Admin", status: "active" }),
    ];
    // A suspended or merely invited Owner can administer nothing, so counting
    // them would strand the org exactly as surely as having none.
    expect(countActiveOwners(rows)).toBe(1);
  });
});

describe("display helpers", () => {
  it("prefers the full name and falls back to the address", () => {
    expect(memberDisplayName(member())).toBe("Ada Lovelace");
    expect(memberDisplayName(member({ full_name: null }))).toBe("person@example.com");
    expect(memberDisplayName(member({ full_name: "   " }))).toBe("person@example.com");
  });

  it("builds initials from first and last name", () => {
    expect(memberInitials(member())).toBe("AL");
    expect(memberInitials(member({ full_name: "Cher" }))).toBe("CH");
    expect(memberInitials(member({ full_name: null }))).toBe("P");
  });

  it("describes each status", () => {
    expect(memberStatusMeta("invited").label).toBe("Invited");
    expect(memberStatusMeta("invited").hint).toMatch(/Grants nothing/);
    expect(memberStatusMeta("suspended").variant).toBe("cancelled");
    expect(memberStatusMeta("nonsense").label).toBe("nonsense");
  });

  it("blurbs every role the API can return", () => {
    for (const role of ["Owner", "Admin", "Editor", "Approver", "Viewer"]) {
      expect(roleBlurb(role)).not.toBe("");
    }
    expect(roleBlurb("Unknown")).toBe("");
  });
});

describe("sortMembers", () => {
  it("puts pending invitations first, then oldest membership first", () => {
    const rows = [
      member({ id: "b", status: "active", created_at: "2026-08-02T00:00:00Z" }),
      member({ id: "a", status: "active", created_at: "2026-08-01T00:00:00Z" }),
      member({ id: "i", status: "invited", created_at: "2026-08-03T00:00:00Z" }),
    ];
    expect(sortMembers(rows).map((r) => r.id)).toEqual(["i", "a", "b"]);
  });

  it("does not mutate its input", () => {
    const rows = [member({ id: "b", status: "active" }), member({ id: "i", status: "invited" })];
    sortMembers(rows);
    expect(rows.map((r) => r.id)).toEqual(["b", "i"]);
  });
});
