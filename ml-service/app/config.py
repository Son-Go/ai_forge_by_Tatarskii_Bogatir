from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, SecretStr, StringConstraints, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

MAX_DEADLINE_MS = 180_000

SettingText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
EndpointId = Annotated[str, StringConstraints(pattern=r"^[a-zA-Z0-9_-]+$")]


class Settings(BaseSettings):
    """Параметры профиля сервера и развёрнутой модели."""

    model_config = SettingsConfigDict(env_ignore_empty=True, hide_input_in_errors=True)

    ml_service_token: SecretStr | None = None
    ml_usage_log_file: Path | None = None
    runpod_api_key: SecretStr | None = None
    runpod_endpoint_id: EndpointId | None = None
    runpod_model: SettingText | None = None
    runpod_model_version: SettingText | None = None
    runpod_max_concurrency: int = Field(default=1, ge=1, le=16)
    runpod_response_format: Literal["prompt", "json_schema"] = "prompt"
    ml_max_context_bytes: int = Field(default=24_000, ge=4_000, le=100_000)

    @field_validator("ml_service_token", "runpod_api_key")
    @classmethod
    def validate_secret(cls, value: SecretStr | None) -> SecretStr | None:
        if value is not None:
            secret = value.get_secret_value()
            if not secret or not all("!" <= char <= "~" for char in secret):
                raise ValueError("Expected printable ASCII without whitespace")
        return value
