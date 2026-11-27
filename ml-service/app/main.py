import asyncio
import logging
import secrets
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from json import JSONDecodeError
from time import perf_counter
from typing import Annotated
from uuid import uuid4

import httpx
from anyio import CancelScope
from fastapi import APIRouter, Depends, FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.sse import EventSourceResponse, ServerSentEvent
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from pydantic import TypeAdapter, ValidationError

from . import prompts
from .config import MAX_DEADLINE_MS, Settings
from .errors import InvalidModelOutput, ServiceError, validate_model_json
from .runpod import RunpodClient
from .schemas import (
    Block,
    ClearUpdate,
    Complete,
    ComposeRequest,
    Error,
    Health,
    InterpretRequest,
    InterpretResult,
    ModelRequest,
    RequestId,
    SetOperation,
)
from .telemetry import RunpodCall, registry, usage_log

MAX_BLOCKS = 4
MAX_BLOCK_JSON_CHARS = 16_384
logger = logging.getLogger("uvicorn.error").getChild("ml_service")
bearer = HTTPBearer(auto_error=False, scheme_name="serviceBearer")
request_id_adapter = TypeAdapter(RequestId)


async def require_token(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
) -> None:
    token = request.app.state.settings.ml_service_token
    if token is None:
        raise ServiceError("ML_NOT_CONFIGURED", "Токен ML-сервиса не настроен.")
    if credentials is None or not secrets.compare_digest(
        credentials.credentials.encode("utf-8"), token.get_secret_value().encode("ascii")
    ):
        raise ServiceError("UNAUTHORIZED", "Требуется сервисный токен.", 401)


async def get_runpod(request: Request) -> RunpodClient:
    provider: RunpodClient | None = request.app.state.runpod
    if provider is None:
        raise ServiceError("ML_NOT_CONFIGURED", "Профиль RunPod не настроен.")
    return provider


Runpod = Annotated[RunpodClient, Depends(get_runpod)]
router = APIRouter(
    prefix="/internal/v1",
    dependencies=[Depends(require_token)],
    responses={
        400: {"model": Error, "description": "Некорректный запрос"},
        401: {"model": Error, "description": "Требуется сервисный токен"},
        503: {"model": Error, "description": "ML-сервис или модель недоступны"},
        "4XX": {"model": Error, "description": "Некорректный запрос"},
    },
)


def model_payload(body: ModelRequest, provider: RunpodClient) -> str:
    payload = body.model_dump_json(by_alias=True, exclude={"request_id", "deadline_ms"})
    if len(payload.encode("utf-8")) > provider.settings.ml_max_context_bytes:
        raise ServiceError("CONTEXT_TOO_LARGE", "Контекст запроса слишком большой.", 400)
    return payload


def make_deadline(deadline_ms: int) -> float:
    return asyncio.get_running_loop().time() + min(deadline_ms, MAX_DEADLINE_MS) / 1_000


@router.post(
    "/interpret",
    operation_id="interpret",
    responses={
        200: {
            "headers": {
                "X-Prompt-Version": {
                    "description": "Версия промпта interpret",
                    "schema": {"type": "string"},
                }
            }
        }
    },
)
async def interpret(
    body: InterpretRequest, provider: Runpod, response: Response
) -> InterpretResult:
    deadline = make_deadline(body.deadline_ms)
    with provider.call("interpret", body.request_id) as call:
        interpretation = await provider.interpret(
            prompts.INTERPRET, model_payload(body, provider), call, deadline
        )
        updates: list[ClearUpdate | SetOperation] = []
        for update in interpretation.updates:
            if update.evidence is not None and update.evidence not in body.text:
                raise InvalidModelOutput(f"{update.op}_evidence_not_in_current_message")
            if update.op == "clear":
                updates.append(ClearUpdate(op="clear", field=update.field))
            else:
                updates.append(update)
        call.succeeded = True
    response.headers["X-Prompt-Version"] = prompts.INTERPRET_VERSION
    return InterpretResult(
        intent=interpretation.intent,
        product_query=interpretation.product_query,
        updates=updates,
        clarification_candidates=interpretation.clarification_candidates,
        model_version=provider.model_version,
    )


def parse_block(line: str, fact_ids: set[str], facts_required: bool) -> Block:
    if len(line) > MAX_BLOCK_JSON_CHARS:
        raise InvalidModelOutput("compose_block_too_large")
    block = validate_model_json(Block, line, "compose_block_schema")
    if not fact_ids.issuperset(block.fact_ids) or (facts_required and not block.fact_ids):
        raise InvalidModelOutput("invalid_compose_fact_references")
    return block


async def model_lines(chunks: AsyncIterator[str]) -> AsyncIterator[str]:
    pending = ""
    async for chunk in chunks:
        lines = (pending + chunk).split("\n")
        pending = lines.pop()
        if len(pending) > MAX_BLOCK_JSON_CHARS:
            raise InvalidModelOutput("compose_block_too_large")
        for line in lines:
            yield line
    if pending:
        yield pending


@dataclass
class Composition:
    body: ComposeRequest
    call: RunpodCall
    chunks: AsyncGenerator[str, None]


async def open_composition(
    body: ComposeRequest, provider: Runpod
) -> AsyncGenerator[Composition, None]:
    deadline = make_deadline(body.deadline_ms)
    payload = model_payload(body, provider)
    with provider.call("compose", body.request_id) as call:
        chunks = provider.stream(prompts.COMPOSE, payload, call, deadline)
        try:
            yield Composition(body, call, chunks)
        finally:
            with CancelScope(shield=True):
                await chunks.aclose()


@router.post(
    "/compose",
    operation_id="compose",
    response_class=EventSourceResponse,
    openapi_extra={
        "responses": {
            "200": {
                "content": {
                    "text/event-stream": {
                        "schema": {"type": "string"},
                        "x-sse-events": {
                            "block": Block.model_json_schema(),
                            "complete": Complete.model_json_schema(),
                            "failed": Error.model_json_schema(),
                        },
                    }
                }
            }
        }
    },
)
async def compose(
    composition: Annotated[Composition, Depends(open_composition, scope="request")],
) -> AsyncGenerator[ServerSentEvent, None]:
    body = composition.body
    started = perf_counter()
    fact_ids = {fact.id for fact in body.facts}
    facts_required = body.outcome in ("recommend", "answer")
    block_count = 0
    try:
        async for line in model_lines(composition.chunks):
            if not line.strip():
                continue
            block_count += 1
            if block_count > MAX_BLOCKS:
                raise InvalidModelOutput("too_many_compose_blocks")
            block = parse_block(line, fact_ids, facts_required)
            if block_count == 1:
                logger.info(
                    "Compose first block request_id=%s elapsed_ms=%.0f",
                    body.request_id,
                    (perf_counter() - started) * 1_000,
                )
            yield ServerSentEvent(event="block", data=block)
        if not block_count:
            raise InvalidModelOutput("missing_compose_blocks")
    except ServiceError as error:
        if isinstance(error, InvalidModelOutput) and composition.call.usage is None:
            # Discard unvalidated text while allowing RunPod to finish reporting usage.
            with suppress(ServiceError):
                async for _ in composition.chunks:
                    pass
        yield ServerSentEvent(event="failed", data=error_body(error, body.request_id))
        return
    composition.call.succeeded = True
    logger.info(
        "Compose complete request_id=%s elapsed_ms=%.0f",
        body.request_id,
        (perf_counter() - started) * 1_000,
    )
    yield ServerSentEvent(
        event="complete",
        data=Complete(
            model_version=composition.call.model_version,
            prompt_version=prompts.COMPOSE_VERSION,
        ),
    )


def error_body(error: ServiceError, request_id: str) -> Error:
    if isinstance(error, InvalidModelOutput):
        logger.warning(
            "ML error request_id=%s code=%s reason=%s", request_id, error.code, error.reason
        )
    else:
        logger.warning("ML error request_id=%s code=%s", request_id, error.code)
    return Error(code=error.code, message=error.message, request_id=request_id)


async def service_error_response(request: Request, error: ServiceError) -> JSONResponse:
    try:
        request_id = request_id_adapter.validate_python((await request.json())["request_id"])
    except (JSONDecodeError, UnicodeDecodeError, KeyError, TypeError, ValidationError):
        request_id = uuid4().hex
    headers = {"WWW-Authenticate": "Bearer"} if error.status_code == 401 else None
    return JSONResponse(
        status_code=error.status_code,
        content=error_body(error, request_id).model_dump(),
        headers=headers,
    )


async def validation_error_response(request: Request, _: RequestValidationError) -> JSONResponse:
    return await service_error_response(
        request, ServiceError("INVALID_REQUEST", "Проверьте поля запроса.", 400)
    )


def create_app(
    settings: Settings | None = None,
    *,
    runpod_transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
        config = settings if settings is not None else Settings()
        with usage_log(config.ml_usage_log_file):
            app.state.settings = config
            app.state.runpod = None
            if not (
                config.runpod_api_key
                and config.runpod_endpoint_id
                and config.runpod_model
                and config.runpod_model_version
            ):
                yield
                return

            async with httpx.AsyncClient(
                base_url=f"https://api.runpod.ai/v2/{config.runpod_endpoint_id}/openai/v1/",
                headers={"Authorization": f"Bearer {config.runpod_api_key.get_secret_value()}"},
                timeout=httpx.Timeout(MAX_DEADLINE_MS / 1_000, connect=5.0),
                limits=httpx.Limits(max_connections=config.runpod_max_concurrency),
                transport=runpod_transport,
            ) as client:
                app.state.runpod = RunpodClient(client, config, config.runpod_model_version)
                try:
                    yield
                finally:
                    app.state.runpod = None

    app = FastAPI(title="Softline Internal ML API", version="0.1.0", lifespan=lifespan)
    app.add_exception_handler(ServiceError, service_error_response)
    app.add_exception_handler(RequestValidationError, validation_error_response)
    app.include_router(router)

    @app.get("/metrics", include_in_schema=False)
    def metrics() -> Response:
        return Response(generate_latest(registry), headers={"Content-Type": CONTENT_TYPE_LATEST})

    @app.get("/health/live", operation_id="mlLiveness")
    async def live() -> Health:
        return Health(status="up")

    @app.get("/health/ready", operation_id="mlReadiness", responses={503: {"model": Health}})
    async def ready(request: Request, response: Response) -> Health:
        if request.app.state.runpod is None or request.app.state.settings.ml_service_token is None:
            response.status_code = 503
            return Health(status="down")
        return Health(status="up")

    return app


app = create_app()
