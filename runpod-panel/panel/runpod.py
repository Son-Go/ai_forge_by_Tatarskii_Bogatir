import asyncio
import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from time import monotonic

import httpx

from .config import Config

MANAGEMENT_URL = "https://api.runpod.io/v2"
INFERENCE_URL = "https://api.runpod.ai/v2"
METRICS_WINDOW = timedelta(hours=24)


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
        idle, running, initializing, throttled, unhealthy = (
            count(summary.get(k))
            for k in ("idle", "running", "initializing", "throttled", "unhealthy")
        )
        rows = data.get("workers")
        stale = current_ready = None
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
            stale = sum(row["isStale"] for row in rows)
            current_ready = sum(
                not row["isStale"] and row["status"] in {"IDLE", "RUNNING"} for row in rows
            )
        return {
            "ready": idle,
            "busy": running,
            "starting": initializing,
            "problem": None if throttled is None or unhealthy is None else throttled + unhealthy,
            "stale_workers": stale,
            "current_ready": current_ready,
            "observed_at": utc_now().isoformat(),
        }

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

    async def probe(self, endpoint_type: str) -> dict:
        if not self.config.inference_key:
            return {"status": "probe_disabled"}
        endpoint = self.config.endpoint_id
        url = (
            f"{INFERENCE_URL}/{endpoint}/openai/v1/chat/completions"
            if endpoint_type == "QUEUE"
            else f"https://{endpoint}.api.runpod.ai/v1/chat/completions"
        )
        started = monotonic()
        try:
            data = await self._request(
                "POST",
                url,
                key=self.config.inference_key,
                seconds=self.config.probe_seconds,
                json={
                    "model": self.config.model,
                    "messages": [{"role": "user", "content": "Reply with exactly OK. /no_think"}],
                    "max_tokens": 16,
                    "chat_template_kwargs": {"enable_thinking": False},
                    "temperature": 0,
                    "stream": False,
                },
            )
            choices = data.get("choices")
            if not isinstance(choices, list) or not choices:
                raise ProviderError("probe_no_answer")
            answer = mapping(mapping(choices[0]).get("message")).get("content")
            # Report the outcome, never arbitrary provider output or sensitive debug text.
            status = (
                "probe_ok"
                if isinstance(answer, str) and answer.strip() == "OK"
                else "probe_unexpected"
            )
        except ProviderError as exc:
            status = exc.code
        return {"status": status, "elapsed_ms": round((monotonic() - started) * 1000)}
