import asyncio
import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from time import monotonic

import httpx

from .config import Config

MANAGEMENT_URL = "https://api.runpod.io/v2"
INFERENCE_URL = "https://api.runpod.ai/v2"
METRICS_WINDOW = timedelta(hours=24)


PROBE_PENDING = {"probe_queued", "probe_processing"}


@dataclass
class ProbeJob:
    id: str
    started: float
    status: str
    finished: float | None = None

    def result(self) -> dict:
        if self.status not in PROBE_PENDING and self.finished is None:
            self.finished = monotonic()
        elapsed = (self.finished if self.finished is not None else monotonic()) - self.started
        return {"status": self.status, "elapsed_ms": round(elapsed * 1000)}


class ProviderError(Exception):
    def __init__(self, code: str, *, uncertain: bool = False):
        super().__init__(code)
        self.code = code
        self.uncertain = uncertain


def mapping(value) -> dict:
    return value if isinstance(value, dict) else {}


def count(value) -> int | None:
    return value if type(value) is int and value >= 0 else None


def amount(value) -> str | None:
    if type(value) not in (int, Decimal, float):
        return None
    number = Decimal(str(value))
    return str(number) if number.is_finite() and abs(number) <= 10**12 else None


def timestamp(value) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        date = datetime.fromisoformat(value)
        return date.astimezone(UTC) if date.tzinfo else None
    except ValueError:
        return None


def utc_now() -> datetime:
    return datetime.now(UTC)


class Runpod:
    def __init__(self, config: Config, client: httpx.AsyncClient):
        self.config = config
        self.client = client
        self.endpoint_url = f"{MANAGEMENT_URL}/serverless/{config.endpoint_id}"
        self._probe_lock = asyncio.Lock()
        self._probe_job: ProbeJob | None = None

    async def _request(
        self, method, url, *, key=None, seconds=8, expect_body=True, money=False, **kwargs
    ):
        try:
            async with asyncio.timeout(seconds):
                response = await self.client.request(
                    method,
                    url,
                    headers={"Authorization": f"Bearer {key or self.config.management_key}"},
                    timeout=seconds,
                    **kwargs,
                )
                if response.is_success:
                    if not expect_body:
                        return {}
                    data = json.loads(response.content, parse_float=Decimal if money else float)
                    if isinstance(data, dict):
                        return data
        except (httpx.TimeoutException, TimeoutError):
            raise ProviderError("provider_timeout", uncertain=True) from None
        except httpx.RequestError:
            raise ProviderError("provider_unreachable", uncertain=True) from None
        except ValueError:
            raise ProviderError("provider_response", uncertain=True) from None

        code = {
            400: "provider_rejected",
            401: "provider_auth",
            403: "provider_auth",
            404: "provider_missing",
            409: "provider_conflict",
            422: "provider_rejected",
            429: "provider_rate_limited",
        }.get(response.status_code, "provider_response")
        raise ProviderError(
            code,
            uncertain=response.is_success
            or response.status_code >= 500
            or response.status_code in {408, 409},
        )

    async def endpoint(self) -> dict:
        data = await self._request("GET", self.endpoint_url)
        workers = mapping(data.get("workers"))
        if (
            data.get("id") != self.config.endpoint_id
            or data.get("type") not in {"QUEUE", "LOAD_BALANCER"}
            or any(count(workers.get(k)) is None for k in ("min", "max"))
        ):
            raise ProviderError("provider_response")
        return data

    async def patch(self, changes: dict) -> None:
        await self._request("PATCH", self.endpoint_url, json=changes, expect_body=False)

    async def workers(self) -> dict:
        data = await self._request("GET", self.endpoint_url + "/workers")
        summary = mapping(data.get("summary"))
        running, initializing, throttled, unhealthy = (
            count(summary.get(k)) for k in ("running", "initializing", "throttled", "unhealthy")
        )
        rows = data.get("workers")
        ready = stale = current_ready = inactive_idle = None
        if (
            isinstance(rows, list)
            and len(rows) == count(summary.get("total"))
            and all(
                type(mapping(row).get("isStale")) is bool
                and mapping(row).get("status")
                in {"IDLE", "RUNNING", "INITIALIZING", "THROTTLED", "UNHEALTHY"}
                for row in rows
            )
        ):
            # Runpod can list scaled-down records as IDLE with no worker uptime.
            idle = [row for row in rows if row["status"] == "IDLE"]
            ready = sum(count(row.get("uptimeSeconds")) is not None for row in idle)
            inactive_idle = len(idle) - ready
            stale = sum(row["isStale"] for row in rows)
            current_ready = sum(
                not row["isStale"]
                and (
                    row["status"] == "RUNNING"
                    or (row["status"] == "IDLE" and count(row.get("uptimeSeconds")) is not None)
                )
                for row in rows
            )
        return {
            "ready": ready,
            "busy": running,
            "starting": initializing,
            "problem": None if throttled is None or unhealthy is None else throttled + unhealthy,
            "stale_workers": stale,
            "current_ready": current_ready,
            "inactive_idle": inactive_idle,
            "observed_at": utc_now().isoformat(),
        }

    async def queue_health(self) -> dict:
        data = await self._request(
            "GET",
            f"{INFERENCE_URL}/{self.config.endpoint_id}/health",
            key=self.config.inference_key,
        )
        workers, jobs = mapping(data.get("workers")), mapping(data.get("jobs"))
        throttled, unhealthy = count(workers.get("throttled")), count(workers.get("unhealthy"))
        ready, running = count(workers.get("ready")), count(workers.get("running"))
        snapshot = {
            "ready": ready,
            "starting": count(workers.get("initializing")),
            "problem": None if throttled is None or unhealthy is None else throttled + unhealthy,
            "runtime_running": running,
            "runtime_active": None if ready is None or running is None else ready + running,
            "jobs_in_progress": count(jobs.get("inProgress")),
        }
        if all(value is None for value in snapshot.values()):
            raise ProviderError("provider_response")
        return snapshot | {"observed_at": utc_now().isoformat()}

    async def metrics(self, kind: str, now: datetime) -> dict:
        fields = (
            ("requests", "failed", "execution_p95", "queue_p95")
            if kind == "requests"
            else ("cold_starts",)
        )
        series = {field: [] for field in fields}
        data = await self._request(
            "GET",
            self.endpoint_url + f"/metrics/{kind}",
            params={
                "interval": "1h",
                "startTime": (now - METRICS_WINDOW).isoformat(),
                "endTime": now.isoformat(),
                "limit": 100,
            },
        )
        records = data.get("records")
        if not isinstance(records, list):
            raise ProviderError("provider_response")
        # At most 25 hourly buckets fit in this window. A cursor means a partial response.
        if mapping(data.get("pagination")).get("hasNextPage") is not False:
            raise ProviderError("provider_response")
        for record in records:
            row = mapping(record)
            time = timestamp(row.get("time"))
            if time is None or time > now or time < now - METRICS_WINDOW - timedelta(hours=1):
                continue
            values = (
                (
                    row.get("requests"),
                    row.get("failed"),
                    mapping(row.get("executionTimeMs")).get("p95"),
                    mapping(row.get("delayTimeMs")).get("p95"),
                )
                if kind == "requests"
                else (row.get("count"),)
            )
            for field, value in zip(fields, values, strict=True):
                if count(value) is not None:
                    series[field].append([time.isoformat(), value])

        result = {}
        for field, points in series.items():
            points.sort()
            last = timestamp(points[-1][0]) if points else None
            result[field] = {
                "points": points,
                "end_at": now.isoformat(),
                "status": "unavailable"
                if last is None
                else ("stale" if now - last > timedelta(hours=2) else "current"),
            }
        return result

    async def billing(self, days: int) -> dict:
        if not self.config.billing_key:
            raise ProviderError("billing_disabled")
        data = await self._request(
            "GET",
            f"{MANAGEMENT_URL}/billing/serverless",
            key=self.config.billing_key,
            money=True,
            params={"bucketSize": "day", "lastN": days, "serverlessId": self.config.endpoint_id},
        )
        records = data.get("records")
        meta = mapping(data.get("metadata"))
        query = mapping(meta.get("query"))
        start, end = timestamp(query.get("startTime")), timestamp(query.get("endTime"))
        if (
            query.get("serverlessId") != self.config.endpoint_id
            or query.get("bucketSize") != "day"
            or start is None
            or end is None
            or end - start != timedelta(days=days)
            or not isinstance(records, list)
            or meta.get("recordCount") != len(records)
        ):
            raise ProviderError("provider_response")
        reported = {}
        for row in records:
            record = mapping(row)
            day = timestamp(record.get("startTime"))
            cost = amount(record.get("totalAmount"))
            if (
                record.get("serverlessId") != self.config.endpoint_id
                or day is None
                or not start <= day < end
                or day in reported
                or cost is None
                or timestamp(record.get("endTime")) != day + timedelta(days=1)
            ):
                raise ProviderError("provider_response")
            reported[day] = cost
        return {
            "total": amount(mapping(meta.get("totals")).get("totalAmount")) if records else None,
            "records": [
                {
                    "day": (start + timedelta(days=i)).date().isoformat(),
                    "amount": reported.get(start + timedelta(days=i)),
                }
                for i in range(days)
            ],
        }

    async def balance(self) -> dict:
        if not self.config.billing_key:
            raise ProviderError("billing_disabled")
        data = await self._request(
            "GET",
            f"{MANAGEMENT_URL}/billing/balance",
            key=self.config.billing_key,
            money=True,
        )
        balance = amount(data.get("balanceAmount"))
        if balance is None or data.get("billingMode") not in {"PREPAID", "POSTPAID"}:
            raise ProviderError("provider_response")
        return {"amount": balance, "mode": data["billingMode"]}

    def probe_budget(self, endpoint_type: str | None) -> int:
        seconds = self.config.probe_seconds
        return min(seconds, 120) if endpoint_type == "LOAD_BALANCER" else seconds

    @staticmethod
    def _probe_answer(output) -> str:
        if isinstance(output, list) and len(output) == 1:
            output = output[0]
        result = mapping(output)
        if result.get("error"):
            return "probe_failed"
        choices = result.get("choices")
        if not isinstance(choices, list) or not choices:
            return "probe_no_answer"
        choice = mapping(choices[0])
        answer = mapping(choice.get("message")).get("content")
        if not isinstance(answer, str) or not answer.strip():
            return (
                "probe_token_limit"
                if choice.get("finish_reason") == "length"
                else "probe_no_answer"
            )
        normalized = answer.strip().strip("\"'«»“”").strip().rstrip(".!").casefold()
        return "probe_ok" if normalized == "ok" else "probe_reply_received"

    def _queued_status(self, data: dict) -> str:
        status = data.get("status")
        if not isinstance(status, str):
            return "provider_response"
        if status == "COMPLETED":
            return self._probe_answer(data.get("output"))
        return {
            "IN_QUEUE": "probe_queued",
            "IN_PROGRESS": "probe_processing",
            "FAILED": "probe_failed",
            "CANCELLED": "probe_cancelled",
            "CANCELED": "probe_cancelled",
            "TIMED_OUT": "probe_provider_timeout",
        }.get(status, "provider_response")

    async def probe_status(self) -> dict | None:
        async with self._probe_lock:
            job = self._probe_job
            if job is None:
                return None
            if job.status in PROBE_PENDING:
                if monotonic() - job.started >= self.probe_budget("QUEUE"):
                    job.status = (
                        "probe_wait_queue_expired"
                        if job.status == "probe_queued"
                        else "probe_wait_running_expired"
                    )
                else:
                    try:
                        data = await self._request(
                            "GET",
                            f"{INFERENCE_URL}/{self.config.endpoint_id}/status/{job.id}",
                            key=self.config.inference_key,
                        )
                        job.status = self._queued_status(data)
                    except ProviderError as exc:
                        if exc.uncertain or exc.code == "provider_rate_limited":
                            return job.result() | {"status_error": exc.code}
                        job.status = exc.code
            return job.result()

    async def probe(self, endpoint_type: str) -> dict:
        if not self.config.inference_key:
            return {"status": "probe_disabled"}
        endpoint = self.config.endpoint_id
        payload = {
            "model": self.config.model,
            "messages": [{"role": "user", "content": "Reply with exactly OK. /no_think"}],
            "max_tokens": 64,
            "chat_template_kwargs": {"enable_thinking": False},
            "temperature": 0,
            "stream": False,
        }
        started = monotonic()
        async with self._probe_lock:
            if (
                self._probe_job
                and self._probe_job.status in PROBE_PENDING
                and started - self._probe_job.started < self.probe_budget("QUEUE")
            ):
                return self._probe_job.result()
            self._probe_job = None
            try:
                if endpoint_type == "QUEUE":
                    data = await self._request(
                        "POST",
                        f"{INFERENCE_URL}/{endpoint}/run",
                        key=self.config.inference_key,
                        json={
                            "input": {
                                "openai_route": "/v1/chat/completions",
                                "openai_input": payload,
                            },
                            "policy": {"ttl": max(10, self.probe_budget("QUEUE")) * 1000},
                        },
                    )
                    job_id = data.get("id")
                    if not isinstance(job_id, str) or not re.fullmatch(
                        r"[A-Za-z0-9_-]{1,128}", job_id
                    ):
                        raise ProviderError("probe_submission_unknown")
                    self._probe_job = ProbeJob(job_id, started, self._queued_status(data))
                    return self._probe_job.result()
                data = await self._request(
                    "POST",
                    f"https://{endpoint}.api.runpod.ai/v1/chat/completions",
                    key=self.config.inference_key,
                    seconds=self.probe_budget(endpoint_type),
                    json=payload,
                )
                status = self._probe_answer(data)
            except ProviderError as exc:
                if endpoint_type == "QUEUE" and exc.uncertain:
                    status = "probe_submission_unknown"
                elif exc.code == "provider_timeout":
                    status = "probe_timeout"
                else:
                    status = exc.code
            return {"status": status, "elapsed_ms": round((monotonic() - started) * 1000)}
