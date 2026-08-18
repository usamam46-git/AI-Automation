import hashlib
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from jose import JWTError, jwt
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
    expire = datetime.now(UTC) + expires_delta if expires_delta else datetime.now(UTC) + timedelta(minutes=settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES)

    to_encode: dict[str, Any] = {
        "sub": user_id,
        "user_id": user_id,
        "org_id": org_id,
        "exp": expire,
        "jti": str(uuid.uuid4()),
        "iat": datetime.now(UTC),
        # Explicit token kind. Added 2026-08-18 alongside invite tokens, which
        # are signed with the SAME key — without a discriminator the only thing
        # separating the two is which claims each happens to carry, and that is
        # a token-confusion bug waiting to be written. `get_current_user`
        # rejects any token whose typ is present and not "access".
        "typ": "access",
    }
    encoded_jwt = jwt.encode(to_encode, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)
    return encoded_jwt


def decode_access_token(token: str) -> dict[str, Any]:
    """
    Decodes the access token.
    Raises jose.JWTError if signature invalid or expired.
    """
    return jwt.decode(token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])


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


# ---------------------------------------------------------------------------
# Organization invitations (Vol. 3 §10)
# ---------------------------------------------------------------------------

#: Token kind claim for an invitation. See `create_invite_token`.
INVITE_TOKEN_TYPE = "invite"


def create_invite_token(*, membership_id: str, org_id: str, email: str) -> str:
    """
    Sign an invitation to join an organization.

    Stateless by design: the membership row is created at the same moment with
    `status="invited"`, and `accept_invitation` requires that row to still be in
    that state. So revocation costs nothing extra — deleting the membership (or
    the invitee accepting it) makes the token inert without a blocklist.

    **It deliberately carries no `sub`, `user_id` or `jti`.** Invitations are
    signed with `JWT_SECRET_KEY`, the same key as access tokens, so anything
    that made this token look like a session would make it usable as one:
    `get_current_user` reads `user_id or sub` and requires `jti`, and an invite
    supplying those would authenticate as that user. The `typ` claim is the
    explicit guard; omitting the identity claims is the belt to its braces.

    `email` is embedded so the accept path can refuse a token opened by someone
    other than its addressee — an invitation is to a person, not a bearer
    credential for anyone who gets the link.
    """
    expire = datetime.now(UTC) + timedelta(days=settings.INVITE_TOKEN_EXPIRE_DAYS)
    to_encode: dict[str, Any] = {
        "typ": INVITE_TOKEN_TYPE,
        "mid": membership_id,
        "org_id": org_id,
        "email": email,
        "exp": expire,
        "iat": datetime.now(UTC),
    }
    return jwt.encode(to_encode, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def decode_invite_token(token: str) -> dict[str, Any]:
    """
    Decode an invitation token.

    Raises `jose.JWTError` on a bad signature, an expired token, or — the case
    that matters — a token of any other kind. An access token presented here
    must NOT be honoured as an invitation any more than the reverse.
    """
    payload = jwt.decode(token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
    if payload.get("typ") != INVITE_TOKEN_TYPE:
        raise JWTError("Not an invitation token")
    return payload
