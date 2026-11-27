import asyncio
import hmac
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .config import Config
from .control import Apply, Change, Control, PanelError
from .runpod import ProviderError, Runpod, utc_now

STATIC = Path(__file__).with_name("static")
BASIC = HTTPBasic(auto_error=False)
LOG = logging.getLogger("panel")


async def timer_loop(control: Control) -> None:
    while True:
        try:
            await control.tick()
        except Exception:
            LOG.error("Timer check failed locally")
        await asyncio.sleep(5)


async def optional(call):
    try:
        return {"data": await call(), "error": None}
    except ProviderError as exc:
        return {"data": None, "error": exc.code}


def create_app(config: Config | None = None, *, transport=None, now=utc_now) -> FastAPI:
    config = config or Config.from_environment()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async with httpx.AsyncClient(
            transport=transport,
            follow_redirects=False,
            trust_env=False,
            limits=httpx.Limits(max_connections=12, max_keepalive_connections=8),
        ) as client:
            control = Control(config, Runpod(config, client), now)
            with control.state.open():
                app.state.control = control
                async with asyncio.TaskGroup() as tasks:
                    timer = tasks.create_task(timer_loop(control))
                    try:
                        yield
                    finally:
                        timer.cancel()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])

    @app.middleware("http")
    async def browser_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.update(
            {
                "Cache-Control": "no-store",
                "Content-Security-Policy": (
                    "default-src 'none'; script-src 'self'; style-src 'self'; "
                    "connect-src 'self'; img-src 'self'; frame-ancestors 'none'; "
                    "base-uri 'none'; form-action 'self'"
                ),
                "X-Content-Type-Options": "nosniff",
                "Referrer-Policy": "no-referrer",
            }
        )
        return response

    @app.exception_handler(PanelError)
    async def panel_error(_request, exc):
        headers = {"WWW-Authenticate": 'Basic realm="Runpod operator"'} if exc.status == 401 else {}
        return JSONResponse({"error": exc.code}, status_code=exc.status, headers=headers)

    @app.exception_handler(ProviderError)
    async def provider_error(_request, exc):
        status = 504 if exc.code == "provider_timeout" else 502
        return JSONResponse({"error": exc.code}, status_code=status)

    @app.exception_handler(RequestValidationError)
    async def invalid_input(_request, _exc):
        return JSONResponse({"error": "invalid_input"}, status_code=422)

    def operator(creds: Annotated[HTTPBasicCredentials | None, Depends(BASIC)]) -> None:
        if creds is None:
            raise PanelError("auth_required", 401)
        user_ok = hmac.compare_digest(creds.username.encode(), config.operator_user.encode())
        password_ok = hmac.compare_digest(
            creds.password.encode(), config.operator_password.encode()
        )
        if not (user_ok and password_ok):
            raise PanelError("auth_required", 401)

    def mutation_origin(request: Request) -> None:
        expected = f"{request.url.scheme}://{request.url.netloc}"
        if (
            request.headers.get("x-panel-request") != "1"
            or request.headers.get("sec-fetch-site") not in {None, "same-origin"}
            or request.headers.get("origin") not in {None, expected}
        ):
            raise PanelError("invalid_origin", 403)

    def controller(request: Request) -> Control:
        return request.app.state.control

    Controller = Annotated[Control, Depends(controller)]
    private = APIRouter(dependencies=[Depends(operator)])
    writes = APIRouter(dependencies=[Depends(mutation_origin)])

    @app.get("/healthz")
    async def health():
        return {"status": "ok"}

    @private.get("/")
    async def page():
        return FileResponse(STATIC / "index.html", media_type="text/html")

    @private.get("/assets/{asset}")
    async def asset(asset: str):
        if asset not in {"panel.js", "i18n.js", "panel.css"}:
            raise PanelError("not_found", 404)
        return FileResponse(STATIC / asset)

    @private.get("/api/state")
    async def state(service: Controller):
        async def settings():
            return service.view(await service.provider.endpoint())

        endpoint, workers = await asyncio.gather(
            optional(settings), optional(service.provider.workers)
        )
        current = endpoint["data"]
        if current and current["type"] == "QUEUE":
            runtime = await optional(service.provider.queue_health)
            if runtime["data"] is not None:
                live = runtime["data"]
                inventory = workers["data"] or {}
                actual = inventory | {k: v for k, v in live.items() if v is not None}
                jobs, busy = live["jobs_in_progress"], inventory.get("busy")
                # Active jobs show whether any work is in progress. They can share a worker.
                if jobs == 0:
                    actual["busy"] = 0
                elif jobs is not None and (not busy or busy > jobs):
                    actual["busy"] = None
                workers = {"data": actual, "error": None}
            elif workers["data"] is not None:
                workers["data"]["runtime_error"] = runtime["error"]
        return {
            "endpoint": endpoint,
            "workers": workers,
            **service.status(),
            "probe_enabled": bool(config.inference_key),
            "probe_timeout_seconds": service.provider.probe_budget(
                current["type"] if current else None
            ),
            "ml_concurrency": config.ml_concurrency,
            "grafana_url": config.grafana_url,
            "estimate": service.estimate(current["active"], current["max"]) if current else None,
        }

    @private.get("/api/metrics")
    async def metrics(service: Controller):
        requests, cold_starts = await asyncio.gather(
            *(
                optional(lambda kind=kind: service.provider.metrics(kind, now()))
                for kind in ("requests", "cold-starts")
            )
        )
        return {"requests": requests, "cold_starts": cold_starts}

    @private.get("/api/costs")
    async def costs(service: Controller):
        today, week, month, balance = await asyncio.gather(
            optional(lambda: service.provider.billing(1)),
            optional(lambda: service.provider.billing(7)),
            optional(lambda: service.provider.billing(30)),
            optional(service.provider.balance),
        )
        return {"today": today, "week": week, "month": month, "balance": balance}

    @writes.post("/api/preview")
    async def preview(change: Change, service: Controller):
        return await service.preview(change)

    @writes.post("/api/apply")
    async def apply(change: Apply, service: Controller):
        return await service.apply(change)

    @writes.post("/api/review")
    async def review(service: Controller):
        return await service.review()

    @private.get("/api/probe")
    async def probe_status(service: Controller):
        return await service.provider.probe_status()

    @writes.post("/api/probe")
    async def probe(service: Controller):
        if not config.inference_key:
            raise PanelError("probe_disabled", 409)
        endpoint = await service.provider.endpoint()
        return await service.provider.probe(endpoint["type"])

    private.include_router(writes)
    app.include_router(private)
    return app
