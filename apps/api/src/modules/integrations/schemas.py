from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator


class IntegrationSetRequest(BaseModel):
    api_key: str = Field(..., min_length=1, description="Raw OpenAI API key. Never stored or echoed back in plaintext.")

    @field_validator("api_key")
    @classmethod
    def _structural_check(cls, v: str) -> str:
        # Structural only — no live call to OpenAI at set-time (see apps/api/CLAUDE.md
        # integrations section for why: a write endpoint shouldn't depend on a
        # third-party network call succeeding).
        if not v.startswith("sk-"):
            raise ValueError("OpenAI API keys start with 'sk-'.")
        return v


class IntegrationStatusResponse(BaseModel):
    type: str
    last_four: str
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
