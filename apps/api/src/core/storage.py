"""
core/storage.py — object storage for knowledge-base documents (MinIO / S3).

Lives in `core/` rather than in `modules/knowledge_base/` for the same reason
`llm_client.py` and `encryption.py` do: it is an infrastructure client that owns
no tables and no routes, and the module convention (`models`/`schemas`/
`repository`/`service`/`router`) has no slot for one.

Until 2026-08-15 this file did not exist. The `minio` service has been running
in `infra/docker-compose.yml` since the initial commit, `boto3` has been a
declared dependency just as long, and `MINIO_*` settings sit in `core/config.py`
— with **no client code anywhere**. This is the first consumer.

## Sync client, two call styles

`boto3` is synchronous and has no async variant worth adopting. The two callers
want opposite things, so both are provided:

- the FastAPI upload path uses the `await`-able wrappers, which hand the blocking
  call to a worker thread — a multi-megabyte PUT on the event loop would stall
  every other request in the process for its duration;
- the Celery ingestion task calls the plain `*_sync` functions directly, because
  it is already running inside its own thread with nothing to starve.

Both share one client. `boto3.client` is documented as thread-safe once
constructed (resources are not), which is what makes a module-level singleton
correct here rather than merely convenient.
"""

from __future__ import annotations

import asyncio
import re
import uuid
from functools import lru_cache
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from src.core.config import settings


class StorageError(RuntimeError):
    """Any object-storage failure, with the vendor exception chained."""


# Everything except a conservative filename set. Applied after the basename is
# taken, so this is belt-and-braces rather than the traversal defence itself.
_UNSAFE_CHARS = re.compile(r"[^A-Za-z0-9._-]+")
_MAX_NAME_LENGTH = 120


@lru_cache(maxsize=1)
def _client() -> Any:
    """
    The shared S3 client.

    `signature_version="s3v4"` is required: MinIO rejects the older v2 signature,
    and the failure is a 400 with a body that does not mention signatures.
    """
    scheme = "https" if settings.MINIO_SECURE else "http"
    return boto3.client(
        "s3",
        endpoint_url=f"{scheme}://{settings.MINIO_ENDPOINT}",
        aws_access_key_id=settings.MINIO_ACCESS_KEY,
        aws_secret_access_key=settings.MINIO_SECRET_KEY,
        config=Config(signature_version="s3v4", retries={"max_attempts": 3, "mode": "standard"}),
    )


def safe_file_name(file_name: str) -> str:
    """
    Reduce a client-supplied filename to something safe to put in an object key.

    A filename arrives in a multipart header and is entirely attacker-controlled.
    `../../etc/passwd` as a key would write outside the intended prefix, so the
    basename is taken first (splitting on BOTH separators — a Windows client
    sends backslashes and `posixpath` would not treat them as separators), then
    anything outside a conservative character set is collapsed.
    """
    base = file_name.replace("\\", "/").rsplit("/", 1)[-1].strip()
    cleaned = _UNSAFE_CHARS.sub("_", base).lstrip(".")
    cleaned = cleaned[:_MAX_NAME_LENGTH]
    return cleaned or "document"


def object_key(
    organization_id: uuid.UUID,
    knowledge_base_id: uuid.UUID,
    document_id: uuid.UUID,
    file_name: str,
) -> str:
    """
    The storage key for one document.

    `knowledge_base/models.py` documents the shape as `org-uuid/kb-uuid/file.pdf`.
    The document id is inserted as a third segment deliberately: without it,
    uploading `policy.pdf` twice into one knowledge base silently overwrites the
    first document's bytes while both rows continue to exist, and the older row
    then re-ingests to the newer file's content. The org/kb prefix the docstring
    specifies is unchanged, so anything listing by tenant still works.
    """
    return f"{organization_id}/{knowledge_base_id}/{document_id}/{safe_file_name(file_name)}"


# ---------------------------------------------------------------------------
# Synchronous API — used directly by the Celery ingestion task
# ---------------------------------------------------------------------------


def ensure_bucket_sync() -> None:
    """Create the configured bucket if it is missing. Idempotent."""
    client = _client()
    try:
        client.head_bucket(Bucket=settings.MINIO_BUCKET)
        return
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        # 404/NoSuchBucket means "create it"; anything else is a real failure
        # (bad credentials return 403 here, and creating would not help).
        if code not in {"404", "NoSuchBucket", "NoSuchKey"}:
            raise StorageError(f"Could not reach bucket '{settings.MINIO_BUCKET}': {exc}") from exc
    except BotoCoreError as exc:
        raise StorageError(f"Could not reach object storage at {settings.MINIO_ENDPOINT}: {exc}") from exc

    try:
        client.create_bucket(Bucket=settings.MINIO_BUCKET)
    except ClientError as exc:
        # Two callers racing the same create is normal and not an error.
        if exc.response.get("Error", {}).get("Code") not in {"BucketAlreadyOwnedByYou", "BucketAlreadyExists"}:
            raise StorageError(f"Could not create bucket '{settings.MINIO_BUCKET}': {exc}") from exc


def put_object_sync(key: str, data: bytes, content_type: str) -> None:
    ensure_bucket_sync()
    try:
        _client().put_object(Bucket=settings.MINIO_BUCKET, Key=key, Body=data, ContentType=content_type)
    except (ClientError, BotoCoreError) as exc:
        raise StorageError(f"Could not store object '{key}': {exc}") from exc


def get_object_sync(key: str) -> bytes:
    try:
        response = _client().get_object(Bucket=settings.MINIO_BUCKET, Key=key)
        return response["Body"].read()
    except (ClientError, BotoCoreError) as exc:
        raise StorageError(f"Could not read object '{key}': {exc}") from exc


def delete_object_sync(key: str) -> None:
    """
    Delete one object. A missing key is NOT an error.

    Deleting a document row whose bytes are already gone must still succeed, or a
    failed upload leaves a row that can never be removed through the API.
    """
    try:
        _client().delete_object(Bucket=settings.MINIO_BUCKET, Key=key)
    except (ClientError, BotoCoreError) as exc:
        raise StorageError(f"Could not delete object '{key}': {exc}") from exc


# ---------------------------------------------------------------------------
# Async wrappers — used by the FastAPI upload path
# ---------------------------------------------------------------------------


async def put_object(key: str, data: bytes, content_type: str) -> None:
    await asyncio.to_thread(put_object_sync, key, data, content_type)


async def get_object(key: str) -> bytes:
    return await asyncio.to_thread(get_object_sync, key)


async def delete_object(key: str) -> None:
    await asyncio.to_thread(delete_object_sync, key)
