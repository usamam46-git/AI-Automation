import asyncio

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import src.db.models  # noqa: F401 — register full ORM graph before queries
from src.core.permissions import (
    AGENT_READ,
    AGENT_WRITE,
    EXECUTION_APPROVE,
    EXECUTION_READ,
    PROMPT_READ,
    PROMPT_WRITE,
    TOOL_READ,
    TOOL_WRITE,
    WORKFLOW_READ,
    WORKFLOW_WRITE,
    WORKSPACE_READ,
    WORKSPACE_WRITE,
)
from src.db.database import AsyncSessionLocal
from src.modules.auth.models import Role


async def seed_system_roles(db: AsyncSession) -> None:
    """
    Seeds the 5 default system roles.
    These roles have organization_id=None and is_system=True.
    """
    roles_data = [
        {
            "name": "Owner",
            "permissions": ["*"],
            "is_system": True,
        },
        {
            "name": "Admin",
            "permissions": [
                WORKFLOW_READ,
                WORKFLOW_WRITE,
                WORKSPACE_READ,
                WORKSPACE_WRITE,
                AGENT_READ,
                AGENT_WRITE,
                PROMPT_READ,
                PROMPT_WRITE,
                TOOL_READ,
                TOOL_WRITE,
                EXECUTION_READ,
                EXECUTION_APPROVE,
                "member:invite",
                "member:remove",
            ],
            "is_system": True,
        },
        {
            "name": "Editor",
            "permissions": [
                WORKFLOW_READ,
                WORKFLOW_WRITE,
                WORKSPACE_READ,
                WORKSPACE_WRITE,
                AGENT_READ,
                AGENT_WRITE,
                PROMPT_READ,
                PROMPT_WRITE,
                TOOL_READ,
                TOOL_WRITE,
            ],
            "is_system": True,
        },
        {
            "name": "Approver",
            "permissions": [EXECUTION_READ, EXECUTION_APPROVE],
            "is_system": True,
        },
        {
            "name": "Viewer",
            "permissions": [
                # In a real app we might expand this, or use wildcard logic "*:read"
                "*:read",
            ],
            "is_system": True,
        },
    ]

    for role_data in roles_data:
        # Check if role exists (use first() to be safe if duplicates ever crept in during dev)
        stmt = select(Role).where(Role.name == role_data["name"], Role.is_system == True)
        result = await db.execute(stmt)
        existing = result.scalars().first()

        if not existing:
            new_role = Role(
                name=role_data["name"],
                permissions=role_data["permissions"],
                is_system=role_data["is_system"],
            )
            db.add(new_role)

    await db.commit()
    print("System roles seeded successfully.")


async def main() -> None:
    async with AsyncSessionLocal() as session:
        await seed_system_roles(session)


if __name__ == "__main__":
    asyncio.run(main())
