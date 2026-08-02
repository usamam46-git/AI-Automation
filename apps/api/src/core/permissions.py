"""
Constants for RBAC permission strings.
These are used to seed the database and to check permissions in API routes.
"""

# Workflow permissions
WORKFLOW_READ = "workflow:read"
WORKFLOW_WRITE = "workflow:write"
WORKFLOW_PUBLISH = "workflow:publish"

# Workspace permissions
WORKSPACE_READ = "workspace:read"
WORKSPACE_WRITE = "workspace:write"

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
WORKFLOW_EXECUTE = "workflow:execute"

# Billing & Org permissions
BILLING_READ = "billing:read"
BILLING_WRITE = "billing:write"
ORG_DELETE = "org:delete"
MEMBER_INVITE = "member:invite"
MEMBER_REMOVE = "member:remove"


def permission_granted(permissions: list[str], required: str) -> bool:
    """Return True if the role's permission list grants the required permission."""
    if "*" in permissions:
        return True
    if required in permissions:
        return True
    if required.endswith(":read") and "*:read" in permissions:
        return True
    return False
