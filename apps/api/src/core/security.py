import hashlib
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from jose import jwt
from passlib.context import CryptContext

from src.core.config import settings

# Setup Passlib with Argon2
pwd_context = CryptContext(schemes=["argon2"], deprecated="auto")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verifies a plain password against the hashed password."""
    return pwd_context.verify(plain_password, hashed_password)


def get_password_hash(password: str) -> str:
    """Hashes a password using Argon2."""
    return pwd_context.hash(password)


def create_access_token(user_id: str, org_id: str, expires_delta: timedelta | None = None) -> str:
    """
    Creates a JWT access token embedding user_id and org_id.
    Includes a unique jti for blocklist capabilities.
    """
    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(
            minutes=settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES
        )

    to_encode: dict[str, Any] = {
        "sub": user_id,
        "user_id": user_id,
        "org_id": org_id,
        "exp": expire,
        "jti": str(uuid.uuid4()),
        "iat": datetime.now(timezone.utc),
    }
    encoded_jwt = jwt.encode(
        to_encode, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM
    )
    return encoded_jwt


def decode_access_token(token: str) -> dict[str, Any]:
    """
    Decodes the access token. 
    Raises jose.JWTError if signature invalid or expired.
    """
    return jwt.decode(
        token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM]
    )


def create_refresh_token() -> str:
    """
    Creates an opaque, high-entropy refresh token.
    This will be hashed before storing in Redis.
    """
    import secrets
    return secrets.token_urlsafe(32)


def hash_refresh_token(token: str) -> str:
    """Returns SHA-256 hex digest of a refresh token for safe Redis storage."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
