"""
modules/chat/models.py — Chat sessions and messages.

Vol. 2 §3.5 — Chat, Notifications, Audit

Tables:
  chats     — a named chat session owned by a Workspace
  messages  — individual messages within a chat (append-only in practice)

Design notes:
- role follows the OpenAI message role convention: user | assistant | system | tool
- tool_calls stores the raw tool-call JSON returned by the model so the UI
  can render the tool-use steps in the chat thread.
"""

import uuid
from typing import Optional

from sqlalchemy import ForeignKey, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from src.db.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class Chat(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """A chat session scoped to a Workspace."""

    __tablename__ = "chats"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    title: Mapped[Optional[str]] = mapped_column(
        Text,
        nullable=True,
        comment="Optional display name for this chat session.",
    )

    # Relationships
    workspace: Mapped["Workspace"] = relationship(  # type: ignore[name-defined]
        "Workspace", back_populates="chats"
    )
    messages: Mapped[list["Message"]] = relationship(
        "Message", back_populates="chat", order_by="Message.created_at"
    )


class Message(UUIDMixin, TimestampMixin, Base):
    """
    A single message within a Chat session.

    Messages are logically append-only — edits are not supported at the DB level.
    tool_calls is the raw JSON array from OpenAI's API when the model invokes
    one or more tools (present only on `assistant` role messages with tool use).
    """

    __tablename__ = "messages"

    chat_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("chats.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    role: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="user | assistant | system | tool",
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    tool_calls: Mapped[Optional[dict]] = mapped_column(
        JSONB,
        nullable=True,
        comment="Raw tool-call JSON from the model (assistant messages only).",
    )

    # Relationships
    chat: Mapped["Chat"] = relationship("Chat", back_populates="messages")
