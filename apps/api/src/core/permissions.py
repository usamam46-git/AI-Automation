"""
Constants for RBAC permission strings.
These are used to seed the database and to check permissions in API routes.
"""

# Workflow permissions
WORKFLOW_READ = "workflow:read"
WORKFLOW_WRITE = "workflow:write"

# Agent permissions
AGENT_READ = "agent:read"
AGENT_WRITE = "agent:write"

# Prompt permissions
PROMPT_READ = "prompt:read"
PROMPT_WRITE = "prompt:write"

# Tool permissions
TOOL_READ = "tool:read"
TOOL_WRITE = "tool:write"

# Execution permissions
EXECUTION_READ = "execution:read"
EXECUTION_APPROVE = "execution:approve"

# Billing & Org permissions
BILLING_READ = "billing:read"
BILLING_WRITE = "billing:write"
ORG_DELETE = "org:delete"
MEMBER_INVITE = "member:invite"
MEMBER_REMOVE = "member:remove"
