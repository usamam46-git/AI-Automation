"""
core/config.py — Pydantic-settings configuration for the AAP backend.

All configuration is sourced from environment variables (or a .env file in
development).  Every service, URL, and secret the application needs is
declared here so there are no scattered `os.getenv()` calls throughout the
codebase.
"""

from pydantic import Field, PostgresDsn, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


from pathlib import Path

# Resolve .env relative to this config file:
# config.py lives at apps/api/src/core/config.py
# .env lives at the api root, two directories up
_API_ROOT = Path(__file__).resolve().parents[2]  # api root
_ENV_FILE = _API_ROOT / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(_ENV_FILE),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ------------------------------------------------------------------
    # App
    # ------------------------------------------------------------------
    APP_NAME: str = "AI Automation Platform"
    APP_ENV: str = Field(default="development")   # development | staging | production
    DEBUG: bool = Field(default=False)
    SECRET_KEY: str = Field(...)                   # General secret
    JWT_SECRET_KEY: str = Field(...)               # used for JWT signing — must be set

    # ------------------------------------------------------------------
    # Database
    # ------------------------------------------------------------------
    DATABASE_URL: str = Field(
        default="postgresql+asyncpg://aap_user:aap_pass@localhost:5432/aap_db",
        description="Async PostgreSQL DSN for SQLAlchemy (asyncpg driver).",
    )
    DB_ECHO: bool = Field(default=False, description="Log all SQL statements (dev only).")

    # ------------------------------------------------------------------
    # Redis
    # ------------------------------------------------------------------
    REDIS_URL: str = Field(default="redis://localhost:6379/0")

    # ------------------------------------------------------------------
    # JWT
    # ------------------------------------------------------------------
    JWT_ALGORITHM: str = "HS256"
    JWT_ACCESS_TOKEN_EXPIRE_MINUTES: int = 15
    JWT_REFRESH_TOKEN_EXPIRE_DAYS: int = 30

    # ------------------------------------------------------------------
    # MinIO / S3-compatible object storage
    # ------------------------------------------------------------------
    MINIO_ENDPOINT: str = Field(default="localhost:9000")
    MINIO_ACCESS_KEY: str = Field(default="minioadmin")
    MINIO_SECRET_KEY: str = Field(default="minioadmin")
    MINIO_BUCKET: str = Field(default="aap-documents")
    MINIO_SECURE: bool = Field(default=False)

    # ------------------------------------------------------------------
    # OpenAI
    # ------------------------------------------------------------------
    OPENAI_API_KEY: str = Field(default="")
    OPENAI_DEFAULT_MODEL: str = "gpt-4.1-mini"

    # ------------------------------------------------------------------
    # LangSmith
    # ------------------------------------------------------------------
    LANGSMITH_API_KEY: str = Field(default="")
    LANGSMITH_PROJECT: str = Field(default="aap-development")
    LANGCHAIN_TRACING_V2: bool = Field(default=False)

    # ------------------------------------------------------------------
    # Sentry
    # ------------------------------------------------------------------
    SENTRY_DSN: str = Field(default="")


# Module-level singleton — import this everywhere:
#   from src.core.config import settings
settings = Settings()
