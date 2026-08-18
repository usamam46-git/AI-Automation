from pydantic import BaseModel, EmailStr, Field, model_validator


class RegisterRequest(BaseModel):
    """
    Registration, in one of two modes.

    Without `invite_token` this is the original flow: a new user, a new
    organization they own, and a default workspace.

    With `invite_token` the user joins an EXISTING organization instead, and
    `organization_name` is not required — creating a throwaway org for someone
    who was invited to a real one is exactly the wrong outcome, and it is what
    made "just register first" an unusable answer before invitations existed.
    The token also proves the address was invited, so the two are validated
    together rather than trusted separately.
    """

    email: EmailStr
    password: str = Field(..., min_length=8)
    full_name: str = Field(..., min_length=1)
    organization_name: str | None = Field(default=None, min_length=1)
    invite_token: str | None = Field(default=None, description="Join an existing org instead of creating one.")

    @model_validator(mode="after")
    def _require_one_path(self) -> "RegisterRequest":
        if not self.invite_token and not self.organization_name:
            raise ValueError("organization_name is required unless an invite_token is supplied")
        return self


class LoginRequest(BaseModel):
    email: EmailStr
    password: str
    organization_id: str | None = Field(default=None, description="Optional org ID to login to if part of multiple")


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    # Note: refresh_token is intentionally omitted here as it will be returned as an httpOnly cookie


class RefreshRequest(BaseModel):
    # Depending on client preference, refresh_token might be passed here or via cookie.
    # For now we'll accept it in body, but in router we'll prioritize the cookie.
    refresh_token: str | None = None


class LogoutRequest(BaseModel):
    # Only if client sends it explicitly. Router will mainly rely on cookie.
    refresh_token: str | None = None
