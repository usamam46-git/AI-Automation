from pydantic import BaseModel, EmailStr, Field


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=8)
    full_name: str = Field(..., min_length=1)
    organization_name: str = Field(..., min_length=1)


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
