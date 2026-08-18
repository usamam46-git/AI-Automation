"""
tests/test_members.py — the org roster, invitations and role assignment.

Vol. 3 §10. Before 2026-08-18 `org_memberships` was written by exactly ONE line
in the codebase (`AuthService.register`), so every user was the sole Owner of
their own org and Editor/Approver/Viewer had never been held by a real user.

The tests that matter most here are not the happy paths — they are the guards
that stop an organization from being locked out of itself, and the ones that
stop an invitation from becoming a bearer credential.
"""

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from src.core.security import create_access_token, create_invite_token, decode_access_token
from src.db.database import async_session_maker
from src.modules.audit_logs.models import AuditLog
from src.modules.auth.models import OrgMembership


async def _owner(client: AsyncClient, tag: str) -> dict:
    """
    Register a fresh org and return its Owner's token, headers and email.

    Deliberately does NOT reuse `test_workflows.register_and_get_token`: that
    helper discards the email it mints, and half the assertions here are about
    which address an invitation was addressed to.
    """
    email = f"owner_{tag}_{uuid.uuid4().hex[:6]}@example.com"
    resp = await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "StrongPassword123!", "full_name": "Owner", "organization_name": f"Org {tag}"},
    )
    assert resp.status_code == 201, resp.text
    token = resp.json()["access_token"]
    payload = decode_access_token(token)
    return {
        "email": email,
        "token": token,
        "headers": {"Authorization": f"Bearer {token}"},
        "org_id": payload["org_id"],
        "user_id": payload["user_id"],
    }


async def _invite(client: AsyncClient, ctx: dict, email: str, role: str = "Editor") -> dict:
    resp = await client.post("/api/v1/organizations/members", json={"email": email, "role_name": role}, headers=ctx["headers"])
    assert resp.status_code == 201, resp.text
    return resp.json()


def _token_from(accept_url: str) -> str:
    return accept_url.split("token=", 1)[1]


# ---------------------------------------------------------------------------
# 1. The roster
# ---------------------------------------------------------------------------


async def test_a_new_org_has_exactly_one_member_its_owner(client: AsyncClient):
    ctx = await _owner(client, "roster")

    resp = await client.get("/api/v1/organizations/members", headers=ctx["headers"])
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["email"] == ctx["email"]
    assert rows[0]["role_name"] == "Owner"
    assert rows[0]["status"] == "active"


async def test_members_me_reports_the_callers_role_and_permissions(client: AsyncClient):
    ctx = await _owner(client, "me")

    resp = await client.get("/api/v1/organizations/members/me", headers=ctx["headers"])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["role_name"] == "Owner"
    assert body["permissions"] == ["*"]
    assert body["email"] == ctx["email"]


async def test_all_permissions_is_complete(client: AsyncClient):
    """
    ALL_PERMISSIONS is hand-maintained so it stays auditable by reading it. This
    catches the failure that follows from forgetting it: a new permission would
    be invisible to `expand_permissions`, so the roles screen would under-report
    what a role can do — the one direction it must never be wrong in.
    """
    import src.core.permissions as perms

    declared = {
        value for name, value in vars(perms).items() if name.isupper() and isinstance(value, str) and ":" in value and not name.startswith("_")
    }
    assert declared == set(perms.ALL_PERMISSIONS)


async def test_expand_permissions_agrees_with_permission_granted(client: AsyncClient):
    """
    The two must never disagree: one decides what the API allows, the other
    decides what the UI tells a person they are granting. A gap between them is
    a screen that lies about access.
    """
    from src.core.permissions import ALL_PERMISSIONS, expand_permissions, permission_granted

    for stored in (["*"], ["*:read"], ["execution:read", "execution:approve"], []):
        expanded = set(expand_permissions(stored))
        for permission in ALL_PERMISSIONS:
            assert (permission in expanded) is permission_granted(stored, permission), f"{stored} / {permission}"


async def test_viewers_wildcard_does_not_expand_to_the_sensitive_reads(client: AsyncClient):
    from src.core.permissions import expand_permissions

    viewer = expand_permissions(["*:read"])
    assert "member:read" in viewer
    assert "workflow:read" in viewer
    for exempt in ("integration:read", "billing:read", "audit:read"):
        assert exempt not in viewer


async def test_roles_endpoint_returns_the_expanded_grant(client: AsyncClient):
    ctx = await _owner(client, "expanded")

    rows = (await client.get("/api/v1/organizations/roles", headers=ctx["headers"])).json()
    viewer = next(r for r in rows if r["name"] == "Viewer")
    # The stored column is a wildcard; the UI needs the resolved set.
    assert viewer["permissions"] == ["*:read"]
    assert "workflow:read" in viewer["effective_permissions"]
    assert "audit:read" not in viewer["effective_permissions"]

    me = (await client.get("/api/v1/organizations/members/me", headers=ctx["headers"])).json()
    assert me["permissions"] == ["*"]
    assert len(me["effective_permissions"]) > 20


async def test_owner_is_listed_for_reference_but_not_assignable(client: AsyncClient):
    """
    The roles endpoint feeds two surfaces: the assignment dropdowns and the
    reference table. The table has to show Owner — omitting the role that can do
    everything answers "who can do X" wrongly — so the flag, not the list
    length, is what keeps Owner out of a dropdown.
    """
    ctx = await _owner(client, "roles")

    resp = await client.get("/api/v1/organizations/roles", headers=ctx["headers"])
    assert resp.status_code == 200, resp.text
    rows = resp.json()

    # Ordered by power, not alphabetically — sorting by name puts Approver above
    # Editor and implies a hierarchy that does not exist.
    assert [row["name"] for row in rows] == ["Owner", "Admin", "Editor", "Approver", "Viewer"]

    by_name = {row["name"]: row for row in rows}
    assert by_name["Owner"]["assignable"] is False
    assert all(by_name[name]["assignable"] for name in ("Admin", "Editor", "Approver", "Viewer"))
    # And Owner's grant really is everything, expanded from ["*"].
    assert "org:delete" in by_name["Owner"]["effective_permissions"]


async def test_the_roster_is_org_scoped(client: AsyncClient):
    a = await _owner(client, "tenant-a")
    b = await _owner(client, "tenant-b")

    rows_a = (await client.get("/api/v1/organizations/members", headers=a["headers"])).json()
    emails = {row["email"] for row in rows_a}
    assert a["email"] in emails
    assert b["email"] not in emails


# ---------------------------------------------------------------------------
# 2. Invitations
# ---------------------------------------------------------------------------


async def test_invite_creates_a_pending_row_and_returns_a_link(client: AsyncClient):
    ctx = await _owner(client, "invite")

    body = await _invite(client, ctx, "newcomer@example.com", "Editor")

    assert body["member"]["status"] == "invited"
    assert body["member"]["email"] == "newcomer@example.com"
    assert body["member"]["role_name"] == "Editor"
    assert body["member"]["user_id"] is None, "no account exists for that address yet"
    assert "/accept-invite?token=" in body["accept_url"]
    assert body["expires_in_days"] == 7

    rows = (await client.get("/api/v1/organizations/members", headers=ctx["headers"])).json()
    assert len(rows) == 2
    # Pending invitations sort first — they are the rows needing an action.
    assert rows[0]["status"] == "invited"


async def test_a_pending_invitation_grants_nothing(client: AsyncClient):
    """
    The whole safety of a nullable user_id rests on this: every permission path
    filters status='active', so an invited row is inert until accepted.
    """
    ctx = await _owner(client, "inert")
    invitee = await _owner(client, "inert-user")
    await _invite(client, ctx, invitee["email"], "Admin")

    # The invitee's own token is scoped to their own org; switching to the
    # inviting org must fail while the membership is only `invited`.
    resp = await client.post(f"/api/v1/auth/switch-org/{ctx['org_id']}", headers=invitee["headers"])
    assert resp.status_code == 403


async def test_inviting_the_same_address_twice_is_a_conflict(client: AsyncClient):
    ctx = await _owner(client, "dupe")
    await _invite(client, ctx, "dupe@example.com")

    resp = await client.post("/api/v1/organizations/members", json={"email": "dupe@example.com", "role_name": "Viewer"}, headers=ctx["headers"])
    assert resp.status_code == 409
    assert "pending invitation" in resp.json()["detail"]


async def test_inviting_an_existing_member_is_a_conflict(client: AsyncClient):
    ctx = await _owner(client, "already")

    resp = await client.post("/api/v1/organizations/members", json={"email": ctx["email"], "role_name": "Viewer"}, headers=ctx["headers"])
    assert resp.status_code == 409
    assert "already a member" in resp.json()["detail"]


async def test_invitations_are_case_insensitive_on_the_address(client: AsyncClient):
    ctx = await _owner(client, "case")
    await _invite(client, ctx, "Mixed.Case@example.com")

    resp = await client.post("/api/v1/organizations/members", json={"email": "mixed.case@example.com", "role_name": "Viewer"}, headers=ctx["headers"])
    assert resp.status_code == 409


async def test_owner_cannot_be_assigned_through_the_invite_endpoint(client: AsyncClient):
    ctx = await _owner(client, "no-owner")

    resp = await client.post("/api/v1/organizations/members", json={"email": "x@example.com", "role_name": "Owner"}, headers=ctx["headers"])
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# 3. Accepting
# ---------------------------------------------------------------------------


async def test_an_existing_user_accepts_and_becomes_active(client: AsyncClient):
    ctx = await _owner(client, "accept")
    invitee = await _owner(client, "accept-user")

    body = await _invite(client, ctx, invitee["email"], "Approver")
    token = _token_from(body["accept_url"])

    resp = await client.post(f"/api/v1/organizations/invitations/{token}/accept", headers=invitee["headers"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["role_name"] == "Approver"
    assert resp.json()["organization_id"] == ctx["org_id"]

    # And now they really are in: switch-org succeeds where it 403'd before.
    switched = await client.post(f"/api/v1/auth/switch-org/{ctx['org_id']}", headers=invitee["headers"])
    assert switched.status_code == 200, switched.text

    new_headers = {"Authorization": f"Bearer {switched.json()['access_token']}"}
    me = await client.get("/api/v1/organizations/members/me", headers=new_headers)
    assert me.json()["role_name"] == "Approver"
    assert me.json()["status"] == "active"


async def test_an_invitation_cannot_be_accepted_by_someone_else(client: AsyncClient):
    """
    An invitation is addressed to a person. Without this check a forwarded link
    is a bearer credential for joining someone else's organization.
    """
    ctx = await _owner(client, "wrong-user")
    intended = await _owner(client, "intended")
    interloper = await _owner(client, "interloper")

    body = await _invite(client, ctx, intended["email"])
    token = _token_from(body["accept_url"])

    resp = await client.post(f"/api/v1/organizations/invitations/{token}/accept", headers=interloper["headers"])
    assert resp.status_code == 403
    assert intended["email"] in resp.json()["detail"]


async def test_an_invitation_cannot_be_accepted_twice(client: AsyncClient):
    ctx = await _owner(client, "twice")
    invitee = await _owner(client, "twice-user")
    body = await _invite(client, ctx, invitee["email"])
    token = _token_from(body["accept_url"])

    assert (await client.post(f"/api/v1/organizations/invitations/{token}/accept", headers=invitee["headers"])).status_code == 200
    second = await client.post(f"/api/v1/organizations/invitations/{token}/accept", headers=invitee["headers"])
    assert second.status_code == 400


async def test_revoking_a_pending_invitation_makes_its_link_inert(client: AsyncClient):
    """Revocation is free precisely because the token is checked against a row."""
    ctx = await _owner(client, "revoke")
    invitee = await _owner(client, "revoke-user")
    body = await _invite(client, ctx, invitee["email"])
    token = _token_from(body["accept_url"])

    deleted = await client.delete(f"/api/v1/organizations/members/{body['member']['id']}", headers=ctx["headers"])
    assert deleted.status_code == 204

    resp = await client.post(f"/api/v1/organizations/invitations/{token}/accept", headers=invitee["headers"])
    assert resp.status_code == 400


@pytest.mark.parametrize("bad", ["not-a-token", "a.b.c"])
async def test_every_invitation_failure_returns_one_identical_message(client: AsyncClient, bad: str):
    """
    Uniform 400, same reasoning as the webhook trigger's uniform 401: a helpful
    error here reports which membership UUIDs exist to an anonymous caller.
    """
    ctx = await _owner(client, "uniform")
    invitee = await _owner(client, "uniform-user")
    body = await _invite(client, ctx, invitee["email"])
    accepted_token = _token_from(body["accept_url"])
    await client.post(f"/api/v1/organizations/invitations/{accepted_token}/accept", headers=invitee["headers"])

    # A revoked/used token and structural garbage must be indistinguishable.
    used = await client.get(f"/api/v1/organizations/invitations/{accepted_token}")
    garbage = await client.get(f"/api/v1/organizations/invitations/{bad}")
    assert used.status_code == garbage.status_code == 400
    assert used.json()["detail"] == garbage.json()["detail"]


async def test_invitation_preview_is_public_and_says_only_what_it_must(client: AsyncClient):
    ctx = await _owner(client, "preview")
    body = await _invite(client, ctx, "guest@example.com", "Viewer")
    token = _token_from(body["accept_url"])

    resp = await client.get(f"/api/v1/organizations/invitations/{token}")  # no auth header
    assert resp.status_code == 200, resp.text
    assert set(resp.json()) == {"organization_name", "email", "role_name"}
    assert resp.json()["email"] == "guest@example.com"
    assert resp.json()["role_name"] == "Viewer"


# ---------------------------------------------------------------------------
# 4. Token separation — an invite is not a session
# ---------------------------------------------------------------------------


async def test_an_invite_token_is_not_usable_as_an_access_token(client: AsyncClient):
    """
    Both are signed with JWT_SECRET_KEY. If an invite ever carried sub/user_id
    and jti it would authenticate as that user, so this is the regression guard
    for the whole two-token design.
    """
    token = create_invite_token(membership_id=str(uuid.uuid4()), org_id=str(uuid.uuid4()), email="x@example.com")

    resp = await client.get("/api/v1/organizations/members", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 401


async def test_an_access_token_is_not_usable_as_an_invitation(client: AsyncClient):
    access = create_access_token(str(uuid.uuid4()), str(uuid.uuid4()))
    resp = await client.get(f"/api/v1/organizations/invitations/{access}")
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# 5. Registering through an invitation
# ---------------------------------------------------------------------------


async def test_registering_with_an_invite_joins_that_org_and_creates_no_other(client: AsyncClient):
    ctx = await _owner(client, "reg-invite")
    body = await _invite(client, ctx, "brandnew@example.com", "Editor")
    token = _token_from(body["accept_url"])

    resp = await client.post(
        "/api/v1/auth/register",
        json={"email": "brandnew@example.com", "password": "StrongPassword123!", "full_name": "New Person", "invite_token": token},
    )
    assert resp.status_code == 201, resp.text

    payload = decode_access_token(resp.json()["access_token"])
    assert payload["org_id"] == ctx["org_id"], "must land in the inviting org, not a fresh one"

    headers = {"Authorization": f"Bearer {resp.json()['access_token']}"}
    me = await client.get("/api/v1/organizations/members/me", headers=headers)
    assert me.json()["role_name"] == "Editor"

    async with async_session_maker() as session:
        rows = (await session.execute(select(OrgMembership).where(OrgMembership.invited_email == "brandnew@example.com"))).scalars().all()
    assert len(rows) == 1, "the invited row is filled in, not duplicated"
    assert rows[0].status == "active"


async def test_registering_without_an_org_name_or_invite_is_rejected(client: AsyncClient):
    resp = await client.post(
        "/api/v1/auth/register",
        json={"email": "noorg@example.com", "password": "StrongPassword123!", "full_name": "No Org"},
    )
    assert resp.status_code == 422


async def test_registering_with_an_invite_addressed_to_someone_else_is_refused(client: AsyncClient):
    ctx = await _owner(client, "reg-wrong")
    body = await _invite(client, ctx, "intended@example.com")
    token = _token_from(body["accept_url"])

    resp = await client.post(
        "/api/v1/auth/register",
        json={"email": "someoneelse@example.com", "password": "StrongPassword123!", "full_name": "Nope", "invite_token": token},
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# 6. The lock-out guards
# ---------------------------------------------------------------------------


async def _second_admin(client: AsyncClient, ctx: dict, tag: str) -> tuple[dict, str]:
    """Invite + accept a second user as Admin. Returns (their ctx, membership_id)."""
    other = await _owner(client, tag)
    body = await _invite(client, ctx, other["email"], "Admin")
    token = _token_from(body["accept_url"])
    await client.post(f"/api/v1/organizations/invitations/{token}/accept", headers=other["headers"])
    return other, body["member"]["id"]


async def test_the_last_active_owner_cannot_be_demoted(client: AsyncClient):
    ctx = await _owner(client, "last-owner-role")
    other, _ = await _second_admin(client, ctx, "lo-admin")

    switched = await client.post(f"/api/v1/auth/switch-org/{ctx['org_id']}", headers=other["headers"])
    admin_headers = {"Authorization": f"Bearer {switched.json()['access_token']}"}

    rows = (await client.get("/api/v1/organizations/members", headers=admin_headers)).json()
    owner_row = next(r for r in rows if r["role_name"] == "Owner")

    resp = await client.patch(f"/api/v1/organizations/members/{owner_row['id']}/role", json={"role_name": "Viewer"}, headers=admin_headers)
    assert resp.status_code == 409
    assert "last active Owner" in resp.json()["detail"]


async def test_the_last_active_owner_cannot_be_removed_or_suspended(client: AsyncClient):
    ctx = await _owner(client, "last-owner-rm")
    other, _ = await _second_admin(client, ctx, "lo-admin2")
    switched = await client.post(f"/api/v1/auth/switch-org/{ctx['org_id']}", headers=other["headers"])
    admin_headers = {"Authorization": f"Bearer {switched.json()['access_token']}"}

    rows = (await client.get("/api/v1/organizations/members", headers=admin_headers)).json()
    owner_row = next(r for r in rows if r["role_name"] == "Owner")

    removed = await client.delete(f"/api/v1/organizations/members/{owner_row['id']}", headers=admin_headers)
    assert removed.status_code == 409

    suspended = await client.patch(f"/api/v1/organizations/members/{owner_row['id']}/status", json={"status": "suspended"}, headers=admin_headers)
    assert suspended.status_code == 409


async def test_nobody_can_change_their_own_role_or_status(client: AsyncClient):
    ctx = await _owner(client, "self")
    rows = (await client.get("/api/v1/organizations/members", headers=ctx["headers"])).json()
    own = rows[0]["id"]

    role = await client.patch(f"/api/v1/organizations/members/{own}/role", json={"role_name": "Viewer"}, headers=ctx["headers"])
    assert role.status_code == 409

    status_resp = await client.patch(f"/api/v1/organizations/members/{own}/status", json={"status": "suspended"}, headers=ctx["headers"])
    assert status_resp.status_code == 409

    removed = await client.delete(f"/api/v1/organizations/members/{own}", headers=ctx["headers"])
    assert removed.status_code == 409


# ---------------------------------------------------------------------------
# 7. Role changes take effect
# ---------------------------------------------------------------------------


async def test_changing_a_role_changes_what_that_user_can_do(client: AsyncClient):
    """
    The permission cache is keyed by (org, user) and is read before the DB, so a
    role change that does not invalidate it is a change that does not happen.
    """
    ctx = await _owner(client, "effect")
    other, membership_id = await _second_admin(client, ctx, "effect-user")
    switched = await client.post(f"/api/v1/auth/switch-org/{ctx['org_id']}", headers=other["headers"])
    other_headers = {"Authorization": f"Bearer {switched.json()['access_token']}"}

    # As Admin they can read the audit log (audit:read is in Admin's grant).
    assert (await client.get("/api/v1/audit-logs", headers=other_headers)).status_code == 200

    resp = await client.patch(f"/api/v1/organizations/members/{membership_id}/role", json={"role_name": "Viewer"}, headers=ctx["headers"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["role_name"] == "Viewer"

    # Viewer holds "*:read", and audit:read is in WILDCARD_READ_EXEMPT.
    assert (await client.get("/api/v1/audit-logs", headers=other_headers)).status_code == 403


async def test_suspending_a_member_revokes_access_immediately(client: AsyncClient):
    ctx = await _owner(client, "suspend")
    other, membership_id = await _second_admin(client, ctx, "suspend-user")
    switched = await client.post(f"/api/v1/auth/switch-org/{ctx['org_id']}", headers=other["headers"])
    other_headers = {"Authorization": f"Bearer {switched.json()['access_token']}"}

    assert (await client.get("/api/v1/workflows", headers=other_headers)).status_code == 200

    resp = await client.patch(f"/api/v1/organizations/members/{membership_id}/status", json={"status": "suspended"}, headers=ctx["headers"])
    assert resp.status_code == 200, resp.text

    # Their access token is still validly signed — the membership is what died.
    assert (await client.get("/api/v1/workflows", headers=other_headers)).status_code == 403


async def test_a_suspended_member_can_be_reactivated(client: AsyncClient):
    ctx = await _owner(client, "reactivate")
    other, membership_id = await _second_admin(client, ctx, "react-user")
    switched = await client.post(f"/api/v1/auth/switch-org/{ctx['org_id']}", headers=other["headers"])
    other_headers = {"Authorization": f"Bearer {switched.json()['access_token']}"}

    await client.patch(f"/api/v1/organizations/members/{membership_id}/status", json={"status": "suspended"}, headers=ctx["headers"])
    await client.patch(f"/api/v1/organizations/members/{membership_id}/status", json={"status": "active"}, headers=ctx["headers"])

    assert (await client.get("/api/v1/workflows", headers=other_headers)).status_code == 200


# ---------------------------------------------------------------------------
# 8. Tenant isolation
# ---------------------------------------------------------------------------


async def test_one_org_cannot_touch_anothers_roster(client: AsyncClient):
    """404, never 403 — a membership in another org must look nonexistent."""
    a = await _owner(client, "iso-a")
    b = await _owner(client, "iso-b")

    b_rows = (await client.get("/api/v1/organizations/members", headers=b["headers"])).json()
    b_membership = b_rows[0]["id"]

    assert (
        await client.patch(f"/api/v1/organizations/members/{b_membership}/role", json={"role_name": "Viewer"}, headers=a["headers"])
    ).status_code == 404
    assert (await client.delete(f"/api/v1/organizations/members/{b_membership}", headers=a["headers"])).status_code == 404


# ---------------------------------------------------------------------------
# 9. Permission gating
# ---------------------------------------------------------------------------


async def test_a_viewer_can_read_the_roster_but_not_change_it(client: AsyncClient):
    ctx = await _owner(client, "viewer-gate")
    other = await _owner(client, "viewer-user")
    body = await _invite(client, ctx, other["email"], "Viewer")
    await client.post(f"/api/v1/organizations/invitations/{_token_from(body['accept_url'])}/accept", headers=other["headers"])
    switched = await client.post(f"/api/v1/auth/switch-org/{ctx['org_id']}", headers=other["headers"])
    viewer_headers = {"Authorization": f"Bearer {switched.json()['access_token']}"}

    # member:read is deliberately NOT in WILDCARD_READ_EXEMPT.
    assert (await client.get("/api/v1/organizations/members", headers=viewer_headers)).status_code == 200
    assert (
        await client.post("/api/v1/organizations/members", json={"email": "z@example.com", "role_name": "Viewer"}, headers=viewer_headers)
    ).status_code == 403


# ---------------------------------------------------------------------------
# 10. Everything material is audited
# ---------------------------------------------------------------------------


async def test_the_member_lifecycle_is_audited(client: AsyncClient):
    ctx = await _owner(client, "audited")
    other, membership_id = await _second_admin(client, ctx, "audited-user")
    await client.patch(f"/api/v1/organizations/members/{membership_id}/role", json={"role_name": "Viewer"}, headers=ctx["headers"])
    await client.patch(f"/api/v1/organizations/members/{membership_id}/status", json={"status": "suspended"}, headers=ctx["headers"])
    await client.delete(f"/api/v1/organizations/members/{membership_id}", headers=ctx["headers"])

    rows = (await client.get("/api/v1/audit-logs", headers=ctx["headers"])).json()
    actions = [row["action"] for row in rows]
    for expected in (
        "member.invited",
        "member.invitation_accepted",
        "member.role_changed",
        "member.status_changed",
        "member.removed",
    ):
        assert expected in actions, f"{expected} missing from {actions}"

    removal = next(row for row in rows if row["action"] == "member.removed")
    assert removal["metadata"]["email"] == other["email"]

    async with async_session_maker() as session:
        stored = (await session.execute(select(AuditLog).where(AuditLog.action == "member.invited"))).scalars().all()
    # The accept URL carries a live joining credential and must never be logged.
    assert all("token" not in str(row.event_metadata) for row in stored)
