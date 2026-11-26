import asyncio
import logging
from collections.abc import AsyncGenerator, Iterator
from contextlib import AsyncExitStack, contextmanager
from time import perf_counter
from typing import Any

import httpx
from anyio import CancelScope
from httpx_sse import SSEError, aconnect_sse
from pydantic import BaseModel, ValidationError

from .config import Settings
from .errors import InvalidModelOutput, ServiceError
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
def translate_runpod_errors() -> Iterator[None]:
    try:
        yield
    except (TimeoutError, httpx.TimeoutException):
        raise ServiceError("MODEL_TIMEOUT", "Истекло время ожидания модели.") from None
    except httpx.HTTPStatusError as error:
        status = error.response.status_code
        if status in (408, 504):
            raise ServiceError("MODEL_TIMEOUT", "Истекло время ожидания модели.") from None
        logger.warning("Runpod HTTP status=%s", status)
        raise ServiceError("MODEL_UNAVAILABLE", "RunPod не смог обработать запрос.") from None
    except (SSEError, ValidationError):
        raise InvalidModelOutput() from None
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
            "max_tokens": 1_024 if stream else 768,
        }
        if self.settings.runpod_send_chat_template_kwargs:
            body["chat_template_kwargs"] = {"enable_thinking": False}
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
        with translate_runpod_errors():
            async with asyncio.timeout_at(deadline), self.slots:
                response = await self.http.post(
                    "chat/completions",
                    json=self.payload(system_prompt, user_payload, stream=False),
                    headers={"X-Request-Id": request_id},
                )
                response.raise_for_status()
                completion = Completion.model_validate_json(response.content)
                if len(completion.choices) != 1:
                    raise InvalidModelOutput()
                choice = completion.choices[0]
                if choice.finish_reason not in (None, "stop") or not choice.message.content:
                    raise InvalidModelOutput()
                result = Interpretation.model_validate_json(choice.message.content)
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
            with translate_runpod_errors():
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
                        raise InvalidModelOutput()
                    if event.event == "error":
                        raise InvalidModelOutput()
                    if event.data == "[DONE]":
                        return
                    if not event.data:
                        continue
                    chunk = Chunk.model_validate_json(event.data)
                    for choice in chunk.choices:
                        if choice.finish_reason not in (None, "stop"):
                            raise InvalidModelOutput()
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
