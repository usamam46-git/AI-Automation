"""
Central ORM model registry.

Import this module before any SQLAlchemy ORM queries so all mappers are
configured with a complete relationship graph. Mirrors alembic/env.py imports.
"""

# Section 3.1 — Identity & Tenancy
from src.modules.organizations.models import APIKey, Organization  # noqa: F401
from src.modules.auth.models import OrgMembership, Role, User  # noqa: F401
from src.modules.workspaces.models import Workspace  # noqa: F401

# Section 3.2 — Workflow Engine
from src.modules.workflows.models import (  # noqa: F401
    Workflow,
    WorkflowEdge,
    WorkflowNode,
    WorkflowVersion,
)
from src.modules.executions.models import NodeExecution, WorkflowRun  # noqa: F401

# Section 3.3 — Agents, Tools, Prompts
from src.modules.prompts.models import Prompt, PromptVersion  # noqa: F401
from src.modules.tools.models import Tool, ToolExecution  # noqa: F401
from src.modules.agents.models import (  # noqa: F401
    Agent,
    AgentMemory,
    AgentSession,
    AgentVersion,
)

# Section 3.4 — Knowledge Base & RAG
from src.modules.knowledge_base.models import (  # noqa: F401
    Document,
    DocumentChunk,
    KnowledgeBase,
    OCRResult,
)

# Section 3.5 — Chat, Notifications, Audit
from src.modules.chat.models import Chat, Message  # noqa: F401
from src.modules.notifications.models import Notification  # noqa: F401
from src.modules.audit_logs.models import AuditLog  # noqa: F401

# Section 3.6 — Billing, Integrations, Settings
from src.modules.billing.models import BillingAccount, BillingUsageRecord  # noqa: F401
from src.modules.integrations.models import Integration  # noqa: F401
from src.modules.webhooks.models import Webhook  # noqa: F401
from src.modules.settings.models import Setting  # noqa: F401
