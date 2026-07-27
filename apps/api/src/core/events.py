import asyncio
from typing import Any, Callable, Coroutine, Type, TypeVar

T = TypeVar("T")


class EventBus:
    """Minimal async pub/sub event bus."""

    def __init__(self) -> None:
        self._subscribers: dict[Type[Any], list[Callable[[Any], Coroutine[Any, Any, None]]]] = {}

    def subscribe(self, event_type: Type[T]) -> Callable[[Callable[[T], Coroutine[Any, Any, None]]], Callable[[T], Coroutine[Any, Any, None]]]:
        def decorator(func: Callable[[T], Coroutine[Any, Any, None]]) -> Callable[[T], Coroutine[Any, Any, None]]:
            if event_type not in self._subscribers:
                self._subscribers[event_type] = []
            self._subscribers[event_type].append(func)
            return func

        return decorator

    async def publish(self, event: Any) -> None:
        """Publish an event to all registered subscribers."""
        event_type = type(event)
        if event_type in self._subscribers:
            for handler in self._subscribers[event_type]:
                # In a robust system, this might be handled via a background task queue (Celery)
                # or asyncio.create_task to ensure the main request isn't blocked.
                asyncio.create_task(handler(event))


# Global event bus instance
event_bus = EventBus()

# --- Workspace Events ---


class WorkspaceCreatedEvent:
    def __init__(self, workspace_id: str, organization_id: str):
        self.workspace_id = workspace_id
        self.organization_id = organization_id


class WorkspaceUpdatedEvent:
    def __init__(self, workspace_id: str, organization_id: str):
        self.workspace_id = workspace_id
        self.organization_id = organization_id


class WorkspaceDeletedEvent:
    def __init__(self, workspace_id: str, organization_id: str):
        self.workspace_id = workspace_id
        self.organization_id = organization_id


# --- Workflow Events ---


class WorkflowCreatedEvent:
    def __init__(self, workflow_id: str, organization_id: str):
        self.workflow_id = workflow_id
        self.organization_id = organization_id


class WorkflowUpdatedEvent:
    def __init__(self, workflow_id: str, organization_id: str):
        self.workflow_id = workflow_id
        self.organization_id = organization_id


class WorkflowArchivedEvent:
    def __init__(self, workflow_id: str, organization_id: str):
        self.workflow_id = workflow_id
        self.organization_id = organization_id
