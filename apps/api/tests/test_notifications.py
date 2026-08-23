"""
tests/test_notifications.py — the `notify` tool type and notification delivery.

Vol. 5 §14/§15/§16 all terminate in a Notify step, and until 2026-08-23 there
was nothing to compile it to: no NodeType, no handler, `modules/notifications/`
was models-only, and `worker_notifications` booted with an empty task registry.
A leave approval that approves and tells nobody was the whole HR story.

Delivery is stubbed at the httpx boundary in every test here — nothing makes a
real outbound request, the same rule test_tool_nodes.py states.
"""

from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import patch

import httpx
import pytest
from fastapi import status
from httpx import AsyncClient
from sqlalchemy import select

from src.graphs.node_handlers import ToolNodeConfigError, _tool_config, tool_handler
from src.modules.notifications.models import Notification
from src.modules.notifications.service import deliver_notification_sync
from tests.test_workflows import create_workspace, register_and_get_token

STATE: dict[str, Any] = {
    "run_id": "8a1d5e30-0000-4000-8000-00000000000a",
    "node_outputs": {"leave": {"employee": "Dana Okafor", "days": 3, "balance_after": 9}},
}


def _patched_post(*results: Any):
    mock = patch("src.modules.notifications.httpx.Client") if False else patch("httpx.Client")
    client = mock.start()
    client.return_value.__enter__.return_value.post.side_effect = list(results)
    return mock, client.return_value.__enter__.return_value


# ---------------------------------------------------------------------------
# Config validation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "config, expected",
    [
        ({"channel": "email", "title": "x"}, "unsupported 'channel'"),
        ({"channel": "whatsapp", "title": "x"}, "unsupported 'channel'"),
        ({"channel": "webhook", "title": "x"}, "no 'url' to POST to"),
        ({"channel": "in_app", "url": "https://x", "title": "x"}, "does not use one"),
        ({"channel": "in_app"}, "would send an empty notification"),
        ({"title": "x", "user_id": "not-a-uuid"}, "malformed 'user_id'"),
    ],
)
def test_notify_config_is_rejected_at_validation_time(config, expected):
    with pytest.raises(ToolNodeConfigError, match=expected):
        _tool_config({"tool_type": "notify", **config}, "notify_1")


def test_notify_cannot_be_marked_mutating():
    """
    A notification changes no external record, and Vol. 5 puts Notify AFTER the
    gate — accepting the flag would demand a second approval to tell someone the
    first one happened. Same rule and reasoning as `knowledge_search`.
    """
    with pytest.raises(ToolNodeConfigError, match="changes no external record"):
        _tool_config({"tool_type": "notify", "title": "Approved", "is_mutating": True}, "notify_1")


def test_the_default_channel_is_in_app():
    assert _tool_config({"tool_type": "notify", "title": "Approved"}, "n")["channel"] == "in_app"


# ---------------------------------------------------------------------------
# The node writes a row
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_an_in_app_notification_is_written_and_needs_no_transport(client: AsyncClient, session):
    """`in_app` is delivered on the spot: the row IS the delivery for that channel."""
    from src.core.security import decode_access_token

    data = await register_and_get_token(client, "N-inapp")
    org_id = uuid.UUID(decode_access_token(data["access_token"])["org_id"])
    await create_workspace(client, data["access_token"])

    cfg = _tool_config(
        {
            "tool_type": "notify",
            "channel": "in_app",
            "title": "Leave approved",
            "body_fields": {"employee": "node_outputs.leave.employee", "days": "node_outputs.leave.days"},
        },
        "notify_1",
    )
    out = tool_handler({**STATE, "organization_id": str(org_id)}, node_key="notify_1", config=cfg)["node_outputs"]["notify_1"]

    assert out["queued"] is True and out["channel"] == "in_app"

    row = (await session.execute(select(Notification).where(Notification.organization_id == org_id))).scalar_one()
    assert row.status == "delivered" and row.delivered_at is not None
    assert row.payload["title"] == "Leave approved"
    assert row.payload["fields"] == {"employee": "Dana Okafor", "days": 3}
    assert row.payload["source"]["node_key"] == "notify_1"
    # Org-wide unless a user is named — a leave decision goes to whoever is watching.
    assert row.user_id is None


@pytest.mark.asyncio
async def test_a_webhook_notification_is_queued_pending_not_delivered_inline(client: AsyncClient, session, celery_calls):
    """
    THE design point. Vol. 5 puts Notify at the end of a run whose real work is
    already done and already approved — so a Slack outage must not fail it.
    The node reports `queued`, never `delivered`, because at that instant nothing
    has been sent.
    """
    from src.core.security import decode_access_token

    data = await register_and_get_token(client, "N-hook")
    org_id = uuid.UUID(decode_access_token(data["access_token"])["org_id"])

    cfg = _tool_config(
        {"tool_type": "notify", "channel": "webhook", "url": "https://hooks.example.com/services/T/B/tok", "title": "Payroll released"},
        "notify_1",
    )
    with patch("src.workers.notification_tasks.deliver_notification.delay") as delay:
        out = tool_handler({**STATE, "organization_id": str(org_id)}, node_key="notify_1", config=cfg)["node_outputs"]["notify_1"]

    assert out["queued"] is True
    row = (await session.execute(select(Notification).where(Notification.organization_id == org_id))).scalar_one()
    assert row.status == "pending" and row.delivered_at is None
    # Enqueued AFTER the commit, or the worker can race the transaction.
    delay.assert_called_once_with(str(row.id))


@pytest.mark.asyncio
async def test_a_notification_node_never_reaches_the_network_from_the_graph(client: AsyncClient, session):
    """The graph's leg must not block on a third party — no POST happens here at all."""
    from src.core.security import decode_access_token

    data = await register_and_get_token(client, "N-nonet")
    org_id = uuid.UUID(decode_access_token(data["access_token"])["org_id"])

    cfg = _tool_config({"tool_type": "notify", "channel": "webhook", "url": "https://hooks.example.com/x", "title": "t"}, "n")
    with patch("httpx.Client") as http, patch("src.workers.notification_tasks.deliver_notification.delay"):
        tool_handler({**STATE, "organization_id": str(org_id)}, node_key="n", config=cfg)
    assert http.call_count == 0


def test_notify_without_an_organization_in_state_raises():
    """Same rule as knowledge_search: the tenant comes from state, never from node config."""
    cfg = _tool_config({"tool_type": "notify", "title": "x"}, "n")
    with pytest.raises(ToolNodeConfigError, match="no organization_id in graph state"):
        tool_handler({"run_id": "r"}, node_key="n", config=cfg)


# ---------------------------------------------------------------------------
# Delivery
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_delivery_marks_the_row_delivered(client: AsyncClient, session):
    from src.core.security import decode_access_token

    data = await register_and_get_token(client, "N-deliver")
    org_id = uuid.UUID(decode_access_token(data["access_token"])["org_id"])
    row = Notification(
        organization_id=org_id, user_id=None, channel="webhook",
        payload={"title": "Coverage conflict", "body": "", "fields": {"employee": "Dana Okafor"}, "url": "https://hooks.example.com/x"},
        status="pending",
    )
    session.add(row); await session.commit()

    mock, posted = _patched_post(httpx.Response(200, text="ok"))
    try:
        assert deliver_notification_sync(str(row.id)) == "delivered"
    finally:
        mock.stop()

    # Slack renders `text` and ignores unknown keys, so the structured payload
    # survives for any other receiver.
    body = posted.post.call_args.kwargs["json"]
    assert "Coverage conflict" in body["text"] and "employee: Dana Okafor" in body["text"]
    assert body["fields"] == {"employee": "Dana Okafor"}

    await session.refresh(row)
    assert row.status == "delivered" and row.delivered_at is not None and row.error is None


@pytest.mark.asyncio
async def test_a_failed_delivery_is_recorded_on_the_row_not_only_in_a_log(client: AsyncClient, session):
    """`status`/`error` exist so a silently undelivered notification is queryable."""
    from src.core.security import decode_access_token

    data = await register_and_get_token(client, "N-fail")
    org_id = uuid.UUID(decode_access_token(data["access_token"])["org_id"])
    row = Notification(
        organization_id=org_id, channel="webhook",
        payload={"title": "t", "body": "", "fields": {}, "url": "https://hooks.example.com/secret?token=SHOULD-NOT-LEAK"},
        status="pending",
    )
    session.add(row); await session.commit()

    mock, _ = _patched_post(*[httpx.Response(500) for _ in range(3)])
    try:
        assert deliver_notification_sync(str(row.id)) == "failed"
    finally:
        mock.stop()

    await session.refresh(row)
    assert row.status == "failed" and row.delivered_at is None
    assert "SHOULD-NOT-LEAK" not in (row.error or ""), "the webhook URL's query string is a bearer credential"


@pytest.mark.asyncio
async def test_delivery_is_idempotent_on_an_already_delivered_row(client: AsyncClient, session):
    """`task_acks_late` means a crash after delivery causes a redelivery."""
    from src.core.security import decode_access_token

    data = await register_and_get_token(client, "N-idem")
    org_id = uuid.UUID(decode_access_token(data["access_token"])["org_id"])
    row = Notification(organization_id=org_id, channel="webhook", payload={"url": "https://hooks.example.com/x"}, status="delivered")
    session.add(row); await session.commit()

    with patch("httpx.Client") as http:
        assert deliver_notification_sync(str(row.id)) == "delivered"
    assert http.call_count == 0


# ---------------------------------------------------------------------------
# The read API
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_user_sees_their_own_and_org_wide_notifications_but_not_a_colleagues(client: AsyncClient, session):
    from src.core.security import decode_access_token

    data = await register_and_get_token(client, "N-read")
    headers = {"Authorization": f"Bearer {data['access_token']}"}
    claims = decode_access_token(data["access_token"])
    org_id, me = uuid.UUID(claims["org_id"]), uuid.UUID(claims["user_id"])
    # A real second user — `notifications.user_id` carries an FK, so a fabricated
    # UUID cannot stand in for a colleague here.
    other = uuid.UUID(decode_access_token((await register_and_get_token(client, "N-read2"))["access_token"])["user_id"])

    session.add_all([
        Notification(organization_id=org_id, user_id=me, channel="in_app", payload={"title": "mine"}, status="delivered"),
        Notification(organization_id=org_id, user_id=None, channel="in_app", payload={"title": "broadcast"}, status="delivered"),
        Notification(organization_id=org_id, user_id=other, channel="in_app", payload={"title": "colleague"}, status="delivered"),
    ])
    await session.commit()

    body = (await client.get("/api/v1/notifications", headers=headers)).json()
    assert sorted(n["payload"]["title"] for n in body) == ["broadcast", "mine"]


@pytest.mark.asyncio
async def test_marking_read_and_the_unread_filter(client: AsyncClient, session):
    from src.core.security import decode_access_token

    data = await register_and_get_token(client, "N-unread")
    headers = {"Authorization": f"Bearer {data['access_token']}"}
    org_id = uuid.UUID(decode_access_token(data["access_token"])["org_id"])
    row = Notification(organization_id=org_id, channel="in_app", payload={"title": "x"}, status="delivered")
    session.add(row); await session.commit()

    assert len((await client.get("/api/v1/notifications?unread_only=true", headers=headers)).json()) == 1
    marked = await client.patch(f"/api/v1/notifications/{row.id}/read", json={"read": True}, headers=headers)
    assert marked.status_code == status.HTTP_200_OK and marked.json()["read_at"] is not None
    assert (await client.get("/api/v1/notifications?unread_only=true", headers=headers)).json() == []


@pytest.mark.asyncio
async def test_another_orgs_notification_is_a_404_never_a_403(client: AsyncClient, session):
    from src.core.security import decode_access_token

    a = await register_and_get_token(client, "N-orgA")
    b = await register_and_get_token(client, "N-orgB")
    org_b = uuid.UUID(decode_access_token(b["access_token"])["org_id"])
    row = Notification(organization_id=org_b, channel="in_app", payload={"title": "b"}, status="delivered")
    session.add(row); await session.commit()

    resp = await client.patch(
        f"/api/v1/notifications/{row.id}/read", json={"read": True}, headers={"Authorization": f"Bearer {a['access_token']}"}
    )
    assert resp.status_code == status.HTTP_404_NOT_FOUND


@pytest.mark.asyncio
async def test_there_is_no_route_to_create_a_notification(client: AsyncClient):
    """A client-writable notification endpoint is a spam surface with no workflow behind it."""
    data = await register_and_get_token(client, "N-nopost")
    headers = {"Authorization": f"Bearer {data['access_token']}"}
    resp = await client.post("/api/v1/notifications", json={"channel": "in_app", "payload": {}}, headers=headers)
    assert resp.status_code == status.HTTP_405_METHOD_NOT_ALLOWED
