# apps/api/Dockerfile
# Backend container contract per Docs/.../volume-2-backend-architecture.md §16.
# Used by both infra/docker-compose.yml (dev — api/worker_*/beat all build from
# this same image, differentiated by `command:`) and, once built and pushed,
# infra/docker-compose.prod.yml.
FROM python:3.12-slim AS base
WORKDIR /app

# Poetry version pinned to match .github/workflows/ci.yml — poetry.lock is
# lock-version 2.1, which Poetry 1.x refuses to read.
RUN pip install --no-cache-dir poetry==2.4.1
# Install straight into the system interpreter (no venv) so the final CMD can
# invoke `uvicorn`/`celery` directly, matching the blueprint contract.
ENV POETRY_VIRTUALENVS_CREATE=false

COPY pyproject.toml poetry.lock ./
RUN poetry install --no-root --only main --no-interaction

COPY src/ ./src/
COPY alembic/ ./alembic/
COPY alembic.ini ./

ENV PYTHONUNBUFFERED=1
EXPOSE 8000

CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000"]
