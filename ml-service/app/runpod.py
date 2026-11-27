import asyncio
import json
import logging
import re
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
from .telemetry import RunpodCall, Stage

logger = logging.getLogger("uvicorn.error").getChild("runpod")
POLL_SECONDS = 2
PENDING = {"IN_QUEUE", "IN_PROGRESS"}


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

    @contextmanager
    def call(self, stage: Stage, request_id: str) -> Iterator[RunpodCall]:
        call = RunpodCall(request_id, stage, self.model_version)
        try:
            yield call
        finally:
            call.record()

    def payload(
        self, system_prompt: str, user_payload: str, *, stream: bool, max_tokens: int
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": self.settings.runpod_model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_payload},
            ],
            "stream": stream,
            "temperature": 0,
            "chat_template_kwargs": {"enable_thinking": False},
            "max_tokens": max_tokens,
        }
        if stream:
            body["stream_options"] = {"include_usage": True}
        return body

    @staticmethod
    def completion_text(content: bytes) -> str:
        completion = validate_model_json(Completion, content, "completion_schema")
        if len(completion.choices) != 1:
            raise InvalidModelOutput("unexpected_completion_choices")
        choice = completion.choices[0]
        if choice.finish_reason not in (None, "stop"):
            raise InvalidModelOutput("incomplete_completion")
        if not choice.message.content:
            raise InvalidModelOutput("empty_completion")
        return choice.message.content

    @staticmethod
    def job_data(response: httpx.Response) -> dict:
        try:
            data = response.json()
        except ValueError:
            raise InvalidModelOutput("invalid_job_response") from None
        if not isinstance(data, dict) or not isinstance(data.get("status"), str):
            raise InvalidModelOutput("invalid_job_status")
        return data

    async def queued_completion(
        self, payload: dict, call: RunpodCall, deadline: float
    ) -> tuple[bytes, str]:
        headers = {"X-Request-Id": call.request_id}
        remaining_ms = int((deadline - asyncio.get_running_loop().time()) * 1000)
        if remaining_ms <= 0:
            raise TimeoutError
        response = await self.http.post(
            "run",
            headers=headers,
            json={
                "input": {"openai_route": "/v1/chat/completions", "openai_input": payload},
                "policy": {"ttl": max(10_000, remaining_ms)},
            },
        )
        response.raise_for_status()
        data = self.job_data(response)
        job_id = data.get("id")
        if not isinstance(job_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", job_id):
            raise InvalidModelOutput("invalid_job_id")
        try:
            while data["status"] in PENDING:
                await asyncio.sleep(POLL_SECONDS)
                try:
                    response = await self.http.get(f"status/{job_id}", headers=headers)
                except httpx.RequestError:
                    continue
                if response.status_code == 429 or 500 <= response.status_code < 600:
                    continue
                response.raise_for_status()
                data = self.job_data(response)
        finally:
            cancel_budget = 2.0
            if call.stage == "faq_review":
                # The caller may retry as soon as the deadline expires. The job has a TTL.
                cancel_budget = min(cancel_budget, deadline - asyncio.get_running_loop().time())
            if data["status"] in PENDING and cancel_budget > 0:
                # A disconnected turn has no consumer. Cancel only its confirmed job.
                with CancelScope(shield=True):
                    try:
                        async with asyncio.timeout(cancel_budget):
                            await self.http.post(f"cancel/{job_id}", headers=headers)
                    except (httpx.HTTPError, TimeoutError):
                        pass
        status = data["status"]
        if status == "TIMED_OUT":
            raise TimeoutError
        if status != "COMPLETED":
            logger.warning("Runpod job did not complete request_id=%s", call.request_id)
            raise ServiceError("MODEL_UNAVAILABLE", "RunPod не смог обработать запрос.")
        output = data.get("output")
        if isinstance(output, list) and len(output) == 1:
            output = output[0]
        if not isinstance(output, dict):
            raise InvalidModelOutput("invalid_job_output")
        content = json.dumps(output).encode()
        call.read_usage(content)
        if output.get("error"):
            raise ServiceError("MODEL_UNAVAILABLE", "RunPod не смог обработать запрос.")
        return content, job_id

    async def complete[Output: BaseModel](
        self,
        system_prompt: str,
        user_payload: str,
        call: RunpodCall,
        deadline: float,
        *,
        schema: type[Output],
        schema_name: str,
        max_tokens: int,
    ) -> Output:
        request_id = call.request_id
        payload = self.payload(system_prompt, user_payload, stream=False, max_tokens=max_tokens)
        if self.settings.runpod_response_format == "json_schema":
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": schema_name, "schema": schema.model_json_schema()},
            }
        started = perf_counter()
        with translate_runpod_errors(request_id):
            async with asyncio.timeout_at(deadline), self.slots:
                call.started = True
                if self.settings.runpod_request_mode == "queue":
                    content, provider_id = await self.queued_completion(payload, call, deadline)
                else:
                    response = await self.http.post(
                        "chat/completions",
                        json=payload,
                        headers={"X-Request-Id": request_id},
                    )
                    content = response.content
                    call.read_usage(content)
                    response.raise_for_status()
                    provider_id = response.headers.get("x-request-id", "")[:128]
                result = validate_model_json(
                    schema,
                    self.completion_text(content),
                    f"{schema_name}_schema",
                    reject_duplicate_keys=call.stage == "faq_review",
                )
        logger.info(
            "Runpod %s request_id=%s provider_id=%r elapsed_ms=%.0f",
            call.stage,
            request_id,
            provider_id,
            (perf_counter() - started) * 1_000,
        )
        return result

    async def stream(
        self, system_prompt: str, user_payload: str, call: RunpodCall, deadline: float
    ) -> AsyncGenerator[str, None]:
        request_id = call.request_id
        if self.settings.runpod_request_mode == "queue":
            payload = self.payload(system_prompt, user_payload, stream=False, max_tokens=1_024)
            with translate_runpod_errors(request_id):
                async with asyncio.timeout_at(deadline), self.slots:
                    call.started = True
                    content, _ = await self.queued_completion(payload, call, deadline)
                    text = self.completion_text(content)
            yield text
            return
        payload = self.payload(system_prompt, user_payload, stream=True, max_tokens=1_024)
        started = perf_counter()
        resources = AsyncExitStack()
        validation_error = None
        try:
            with translate_runpod_errors(request_id):
                async with asyncio.timeout_at(deadline):
                    await resources.enter_async_context(self.slots)
                    call.started = True
                    source = await resources.enter_async_context(
                        aconnect_sse(
                            self.http,
                            "POST",
                            "chat/completions",
                            json=payload,
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
                    if event.data and event.data != "[DONE]":
                        call.read_usage(event.data)
                    if event.event == "error":
                        raise InvalidModelOutput("provider_stream_error")
                    if event.data == "[DONE]":
                        break
                    if not event.data or validation_error is not None:
                        continue
                    try:
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
                    except InvalidModelOutput as error:
                        # Keep reading until the final usage or the original deadline.
                        validation_error = error
        except ServiceError:
            if validation_error is not None:
                raise validation_error from None
            raise
        finally:
            with CancelScope(shield=True):
                await resources.aclose()
        if validation_error is not None:
            raise validation_error
