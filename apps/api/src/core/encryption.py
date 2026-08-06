"""
core/encryption.py — AES-256-GCM encryption for secrets at rest (Vol. 2 §13).

Distinct from security.py: security.py handles passwords (argon2, one-way)
and JWTs (signed, not encrypted). This module is for secrets the application
must later recover in plaintext — today, org-supplied BYOK API keys stored in
`integrations.credentials`.
"""

import base64
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from src.core.config import settings

_NONCE_SIZE = 12  # bytes — standard AES-GCM nonce length


def _key() -> bytes:
    key = base64.b64decode(settings.INTEGRATION_ENCRYPTION_KEY)
    if len(key) != 32:
        raise ValueError(f"INTEGRATION_ENCRYPTION_KEY must decode to 32 bytes for AES-256, got {len(key)}.")
    return key


def encrypt_secret(plaintext: str) -> bytes:
    """Encrypts plaintext for storage. Returns nonce || ciphertext+tag."""
    nonce = os.urandom(_NONCE_SIZE)
    ciphertext = AESGCM(_key()).encrypt(nonce, plaintext.encode("utf-8"), None)
    return nonce + ciphertext


def decrypt_secret(blob: bytes) -> str:
    """Reverses encrypt_secret. Raises cryptography.exceptions.InvalidTag if blob was tampered with or the key is wrong."""
    nonce, ciphertext = blob[:_NONCE_SIZE], blob[_NONCE_SIZE:]
    plaintext = AESGCM(_key()).decrypt(nonce, ciphertext, None)
    return plaintext.decode("utf-8")
