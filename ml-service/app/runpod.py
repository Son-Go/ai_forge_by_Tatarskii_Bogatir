import asyncio
import logging
from collections.abc import AsyncGenerator, Iterator
from contextlib import AsyncExitStack, contextmanager
from time import perf_counter
from typing import Any

import httpx
from anyio import CancelScope
from httpx_sse import SSEError, aconnect_sse
from pydantic import BaseModel

from .config import Settings
from .errors import InvalidModelOutput, ServiceError, validate_model_json
from .schemas import Interpretation

logger = logging.getLogger("uvicorn.error").getChild("runpod")


class Message(BaseModel):
    content: str | None = None


class Choice(BaseModel):
    message: Message
    finish_reason: str | None = None


class Completion(BaseModel):
    choices: list[Choice]


class ChunkChoice(BaseModel):
    delta: Message
    finish_reason: str | None = None


class Chunk(BaseModel):
    choices: list[ChunkChoice]


@contextmanager
def translate_runpod_errors(request_id: str) -> Iterator[None]:
    try:
        yield
    except (TimeoutError, httpx.TimeoutException):
        raise ServiceError("MODEL_TIMEOUT", "Истекло время ожидания модели.") from None
    except httpx.HTTPStatusError as error:
        status = error.response.status_code
        if status in (408, 504):
            raise ServiceError("MODEL_TIMEOUT", "Истекло время ожидания модели.") from None
        logger.warning("Runpod HTTP status=%s request_id=%s", status, request_id)
        raise ServiceError("MODEL_UNAVAILABLE", "RunPod не смог обработать запрос.") from None
    except SSEError:
        raise InvalidModelOutput("invalid_stream_content_type") from None
    except httpx.HTTPError:
        raise ServiceError("MODEL_UNAVAILABLE", "Соединение с RunPod прервано.") from None


class RunpodClient:
    def __init__(self, http: httpx.AsyncClient, settings: Settings, model_version: str) -> None:
        self.http = http
        self.settings = settings
        self.model_version = model_version
        self.slots = asyncio.Semaphore(settings.runpod_max_concurrency)

    def payload(self, system_prompt: str, user_payload: str, *, stream: bool) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": self.settings.runpod_model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_payload},
            ],
            "stream": stream,
            "temperature": 0,
            "chat_template_kwargs": {"enable_thinking": False},
            "max_tokens": 1_024 if stream else 768,
        }
        if not stream and self.settings.runpod_response_format == "json_schema":
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": "interpretation",
                    "schema": Interpretation.model_json_schema(),
                },
            }
        return body

    async def interpret(
        self, system_prompt: str, user_payload: str, request_id: str, deadline: float
    ) -> Interpretation:
        started = perf_counter()
        with translate_runpod_errors(request_id):
            async with asyncio.timeout_at(deadline), self.slots:
                response = await self.http.post(
                    "chat/completions",
                    json=self.payload(system_prompt, user_payload, stream=False),
                    headers={"X-Request-Id": request_id},
                )
                response.raise_for_status()
                completion = validate_model_json(Completion, response.content, "completion_schema")
                if len(completion.choices) != 1:
                    raise InvalidModelOutput("unexpected_completion_choices")
                choice = completion.choices[0]
                if choice.finish_reason not in (None, "stop"):
                    raise InvalidModelOutput("incomplete_completion")
                if not choice.message.content:
                    raise InvalidModelOutput("empty_completion")
                result = validate_model_json(
                    Interpretation, choice.message.content, "interpretation_schema"
                )
        logger.info(
            "Runpod interpret request_id=%s provider_id=%r elapsed_ms=%.0f",
            request_id,
            response.headers.get("x-request-id", "")[:128],
            (perf_counter() - started) * 1_000,
        )
        return result

    async def stream(
        self, system_prompt: str, user_payload: str, request_id: str, deadline: float
    ) -> AsyncGenerator[str, None]:
        started = perf_counter()
        resources = AsyncExitStack()
        try:
            with translate_runpod_errors(request_id):
                async with asyncio.timeout_at(deadline):
                    await resources.enter_async_context(self.slots)
                    source = await resources.enter_async_context(
                        aconnect_sse(
                            self.http,
                            "POST",
                            "chat/completions",
                            json=self.payload(system_prompt, user_payload, stream=True),
                            headers={"X-Request-Id": request_id},
                        )
                    )
                    source.response.raise_for_status()
                first_token = True
                events = source.aiter_sse()
                while True:
                    async with asyncio.timeout_at(deadline):
                        event = await anext(events, None)
                    if event is None:
                        raise InvalidModelOutput("stream_ended_before_done")
                    if event.event == "error":
                        raise InvalidModelOutput("provider_stream_error")
                    if event.data == "[DONE]":
                        return
                    if not event.data:
                        continue
                    chunk = validate_model_json(Chunk, event.data, "stream_chunk_schema")
                    for choice in chunk.choices:
                        if choice.finish_reason not in (None, "stop"):
                            raise InvalidModelOutput("incomplete_stream")
                        if choice.delta.content:
                            if first_token:
                                logger.info(
                                    "Runpod compose request_id=%s provider_id=%r "
                                    "first_token_ms=%.0f",
                                    request_id,
                                    source.response.headers.get("x-request-id", "")[:128],
                                    (perf_counter() - started) * 1_000,
                                )
                                first_token = False
                            yield choice.delta.content
        finally:
            with CancelScope(shield=True):
                await resources.aclose()
