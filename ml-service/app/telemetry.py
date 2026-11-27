import json
import logging
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Literal

from prometheus_client import CollectorRegistry, Counter
from pydantic import BaseModel, Field, ValidationError

Stage = Literal["interpret", "compose"]
logger = logging.getLogger("uvicorn.error.runpod.usage")
registry = CollectorRegistry()
tokens = Counter(
    "ml_runpod_tokens", "Tokens reported by RunPod", ("stage", "direction"), registry=registry
)
calls = Counter(
    "ml_runpod_calls", "RunPod calls by usage availability", ("stage", "usage_status"),
    registry=registry,
)
for stage in ("interpret", "compose"):
    for direction in ("input", "output"):
        tokens.labels(stage, direction)
    for usage_status in ("reported", "missing"):
        calls.labels(stage, usage_status)


class Usage(BaseModel):
    prompt_tokens: int = Field(strict=True, ge=0)
    completion_tokens: int = Field(strict=True, ge=0)


class UsageEnvelope(BaseModel):
    usage: Usage | None = None


@dataclass
class RunpodCall:
    request_id: str
    stage: Stage
    model_version: str
    started: bool = False
    succeeded: bool = False
    usage: Usage | None = None

    def read_usage(self, body: str | bytes) -> None:
        if self.usage is not None:
            return
        try:
            self.usage = UsageEnvelope.model_validate_json(body).usage
        except ValidationError:
            # Usage is independent from the validity of the model response.
            pass

    def record(self) -> None:
        if not self.started:
            return
        usage_status = "missing"
        if self.usage is not None:
            usage_status = "reported"
            tokens.labels(self.stage, "input").inc(self.usage.prompt_tokens)
            tokens.labels(self.stage, "output").inc(self.usage.completion_tokens)
        calls.labels(self.stage, usage_status).inc()
        logger.info(
            "%s",
            json.dumps(
                {
                    "timestamp": datetime.now(UTC).isoformat(),
                    "request_id": self.request_id,
                    "stage": self.stage,
                    "model_version": self.model_version,
                    "status": "ok" if self.succeeded else "error",
                    "usage_status": usage_status,
                    "prompt_tokens": self.usage.prompt_tokens if self.usage else None,
                    "completion_tokens": self.usage.completion_tokens if self.usage else None,
                }
            ),
        )


@contextmanager
def usage_log(path: Path | None) -> Iterator[None]:
    if path is None:
        yield
        return
    handler = RotatingFileHandler(path, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8")
    previous_level, previous_propagate = logger.level, logger.propagate
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    try:
        yield
    finally:
        logger.removeHandler(handler)
        handler.close()
        logger.setLevel(previous_level)
        logger.propagate = previous_propagate
