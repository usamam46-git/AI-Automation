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

# Knowledge-base permissions (Vol. 2 §3.4) — added 2026-08-15 with the ingestion
# pipeline. Deliberately NOT in WILDCARD_READ_EXEMPT below: a knowledge base
# holds the org's own policy documents, which is ordinary readable content, and
# a Viewer who cannot read it cannot see the evidence behind a grounded answer.
# `knowledge:write` covers uploading and deleting documents as well as the KB
# itself — an upload spends embedding money, so it belongs with the write grant
# rather than the read one.
KNOWLEDGE_READ = "knowledge:read"
KNOWLEDGE_WRITE = "knowledge:write"

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
# Added 2026-08-18 with the members module. Deliberately NOT in
# WILDCARD_READ_EXEMPT: knowing who your colleagues are, and what they are
# allowed to do, is ordinary in-org information — unlike a BYOK key's last four
# or an audit row's client IP. Every role can see the roster; only Owner and
# Admin can change it.
MEMBER_READ = "member:read"

# Integration permissions — Owner-only (not granted to Admin in seed_roles.py),
# same reasoning as BILLING_READ/BILLING_WRITE: a stored BYOK key is a direct
# billing-exposure lever for the org, not an ordinary content-editing concern.
INTEGRATION_READ = "integration:read"
INTEGRATION_WRITE = "integration:write"

# Audit permissions — read-only by design. There is deliberately no
# AUDIT_WRITE: audit_logs is append-only, rows are written by services as a
# side effect of the action they record, and no route may create, edit or
# delete one. See modules/audit_logs/service.py.
AUDIT_READ = "audit:read"

#: Read permissions that the `*:read` wildcard must NOT satisfy.
#:
#: Added 2026-08-09 to close a real hole. The Viewer system role holds
#: `"*:read"`, and the wildcard branch below granted it EVERY `:read`
#: permission — including `integration:read` and `billing:read`, both of which
#: this file and apps/api/CLAUDE.md document as Owner-only. A Viewer could read
#: the org's BYOK integration status (`last_four`) despite that.
#:
#: `audit:read` would have inherited the same hole, and it is the more sensitive
#: of the three: audit rows carry actor identity and client IP addresses.
#:
#: `"*"` (Owner) still grants these — this narrows only the read wildcard, which
#: seed_roles.py already flags as provisional.
WILDCARD_READ_EXEMPT = frozenset({INTEGRATION_READ, BILLING_READ, AUDIT_READ})


def permission_granted(permissions: list[str], required: str) -> bool:
    """Return True if the role's permission list grants the required permission."""
    if "*" in permissions:
        return True
    if required in permissions:
        return True
    if required.endswith(":read") and "*:read" in permissions and required not in WILDCARD_READ_EXEMPT:
        return True
    return False


#: Every permission string the platform defines.
#:
#: Declared explicitly rather than scraped from this module's globals: the list
#: is the vocabulary a role is described BY, so it must be auditable by reading
#: it, and a stray module-level string must not silently become a permission.
#: `test_all_permissions_is_complete` asserts it matches the constants above, so
#: adding one and forgetting this fails the suite rather than quietly producing
#: a role screen that under-reports what a role can do.
ALL_PERMISSIONS: tuple[str, ...] = (
    WORKFLOW_READ,
    WORKFLOW_WRITE,
    WORKFLOW_PUBLISH,
    WORKFLOW_EXECUTE,
    WORKSPACE_READ,
    WORKSPACE_WRITE,
    AGENT_READ,
    AGENT_WRITE,
    PROMPT_READ,
    PROMPT_WRITE,
    TOOL_READ,
    TOOL_WRITE,
    KNOWLEDGE_READ,
    KNOWLEDGE_WRITE,
    EXECUTION_READ,
    EXECUTION_APPROVE,
    MEMBER_READ,
    MEMBER_INVITE,
    MEMBER_REMOVE,
    INTEGRATION_READ,
    INTEGRATION_WRITE,
    BILLING_READ,
    BILLING_WRITE,
    AUDIT_READ,
    ORG_DELETE,
)


def expand_permissions(stored: list[str]) -> list[str]:
    """
    Resolve a role's STORED permission list into the concrete set it grants.

    `roles.permissions` holds wildcards — Owner is literally `["*"]` and Viewer
    `["*:read"]` — so the raw column cannot be rendered to a human deciding what
    to assign. Expanding it is the whole job of this function, and it lives here
    **beside `permission_granted`, on purpose**: the two must agree, and the
    only way to guarantee that is to derive both from the same constants.

    The frontend previously reimplemented the wildcard branch to gate its own
    UI, which meant `WILDCARD_READ_EXEMPT` existed in two languages. It does not
    any more — the API returns the expanded list and the client just reads it.
    `test_expand_permissions_agrees_with_permission_granted` pins the agreement
    across every permission and every system role.

    Unknown strings are preserved rather than dropped: a custom role (Vol. 2
    §658, enterprise plan) may name something this build has not heard of, and
    silently discarding it would under-report what that role can do — the one
    direction a permissions screen must never be wrong in.
    """
    if "*" in stored:
        return list(ALL_PERMISSIONS)

    granted = {p for p in stored if p != "*:read"}
    if "*:read" in stored:
        granted.update(p for p in ALL_PERMISSIONS if p.endswith(":read") and p not in WILDCARD_READ_EXEMPT)

    known = [p for p in ALL_PERMISSIONS if p in granted]
    unknown = sorted(granted - set(ALL_PERMISSIONS))
    return known + unknown
