import asyncio
import json
from contextlib import asynccontextmanager

import httpx
import pytest
from prometheus_client.parser import text_string_to_metric_families
from starlette.requests import ClientDisconnect

from app.config import Settings
from app.main import create_app, make_deadline

AUTH = {"Authorization": "Bearer service-test"}
USAGE = {"prompt_tokens": 41, "completion_tokens": 13}
USAGE_LOGGER = "uvicorn.error.runpod.usage"
INTERPRET = {
    "request_id": "req-interpret",
    "deadline_ms": 1_000,
    "text": "Нужна новая лицензия MDaemon на 50 пользователей",
    "conversation_context": [
        {"role": "user", "text": "Подбираю почтовый сервер"},
        {"role": "assistant", "text": "Уточните количество пользователей."},
    ],
    "requirements": {"domestic_required": False},
}
COMPOSE = {
    "request_id": "req-compose",
    "deadline_ms": 1_000,
    "outcome": "answer",
    "facts": [{"id": "seats", "text": "До 50 пользователей."}],
    "language": "ru",
}
RESULT = {
    "intent": "known_product",
    "product_query": "MDaemon",
    "updates": [
        {"op": "set", "field": "seats", "value": 50, "evidence": "50 пользователей"},
        {"op": "clear", "field": "edition"},
    ],
    "clarification_candidates": ["license_term_months"],
}
pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def settings(monkeypatch):
    for name in Settings.model_fields:
        monkeypatch.delenv(name.upper(), raising=False)
    return Settings(
        ml_service_token="service-test",
        runpod_api_key="provider-test",
        runpod_endpoint_id="endpoint-test",
        runpod_model="org/model-awq",
        runpod_model_version="release-a",
    )


@asynccontextmanager
async def client_for(settings, handler):
    app = create_app(settings, runpod_transport=httpx.MockTransport(handler))
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as client,
    ):
        yield client


def completion(content, **metadata):
    body = {"choices": [{"message": {"content": json.dumps(content)}, "finish_reason": "stop"}]}
    return httpx.Response(200, json=body | metadata)


def chunk(content, *, finish_reason=None):
    choice = {"delta": {"content": content}, "finish_reason": finish_reason}
    return f"data: {json.dumps({'choices': [choice]})}\n\n"


def sse_response(content):
    return httpx.Response(200, headers={"Content-Type": "text/event-stream"}, text=content)


def events(response):
    return [
        (kind.removeprefix("event: "), json.loads(data.removeprefix("data: ")))
        for frame in response.text.split("\n\n")
        if frame.startswith("event: ")
        for kind, data in [frame.splitlines()]
    ]


def usage_event(usage):
    return f"data: {json.dumps({'choices': [], 'usage': usage})}\n\n"


def usage_records(caplog):
    return [
        json.loads(record.getMessage()) for record in caplog.records if record.name == USAGE_LOGGER
    ]


async def usage_counters(client, stage):
    response = await client.get("/metrics")
    assert response.status_code == 200
    assert "request_id" not in response.text
    return {
        sample.labels.get("direction") or sample.labels["usage_status"]: sample.value
        for metric in text_string_to_metric_families(response.text)
        for sample in metric.samples
        if sample.name.endswith("_total") and sample.labels["stage"] == stage
    }


def assert_usage_record(caplog, stage, status, usage, request_id):
    [record] = usage_records(caplog)
    assert record.pop("timestamp")
    assert record == {
        "stage": stage,
        "status": status,
        "usage_status": "missing" if usage is None else "reported",
        "model_version": "release-a",
        "request_id": request_id,
        **(usage if usage is not None else dict.fromkeys(USAGE)),
    }


def unexpected_request(_):
    pytest.fail("RunPod received a request unexpectedly")


async def test_health_and_auth_are_local(settings):
    async with client_for(settings, unexpected_request) as client:
        assert (await client.get("/health/live")).json() == {"status": "up"}
        assert (await client.get("/health/ready")).json() == {"status": "up"}
        response = await client.post("/internal/v1/interpret", json=INTERPRET)
    assert response.status_code == 401
    assert response.headers["WWW-Authenticate"] == "Bearer"
    assert response.json()["request_id"] == INTERPRET["request_id"]


async def test_readiness_down_with_missing_profile(settings):
    settings.runpod_api_key = None
    async with client_for(settings, unexpected_request) as client:
        assert (await client.get("/health/live")).json() == {"status": "up"}
        response = await client.get("/health/ready")
        api_error = await client.post("/internal/v1/interpret", json=INTERPRET, headers=AUTH)
    assert response.status_code == 503
    assert response.json() == {"status": "down"}
    assert api_error.status_code == 503
    assert api_error.json()["code"] == "ML_NOT_CONFIGURED"


@pytest.mark.parametrize(
    "patch", [{"deadline_ms": 0}, {"text": " "}, {"requirements": {"seats": True}}]
)
async def test_invalid_input_is_400_before_runpod(settings, patch):
    async with client_for(settings, unexpected_request) as client:
        response = await client.post("/internal/v1/interpret", json=INTERPRET | patch, headers=AUTH)
    assert response.status_code == 400
    assert response.json()["code"] == "INVALID_REQUEST"


@pytest.mark.parametrize("structured", [False, True])
async def test_interpret_uses_runpod_and_returns_release_metadata(settings, structured):
    if structured:
        settings.runpod_response_format = "json_schema"

    def handler(request):
        assert str(request.url) == (
            "https://api.runpod.ai/v2/endpoint-test/openai/v1/chat/completions"
        )
        assert request.headers["Authorization"] == "Bearer provider-test"
        assert request.headers["X-Request-Id"] == INTERPRET["request_id"]
        assert request.extensions["timeout"]["read"] == 120.0
        body = json.loads(request.content)
        assert body["model"] == "org/model-awq"
        assert body["stream"] is False
        assert body["temperature"] == 0
        assert body["chat_template_kwargs"] == {"enable_thinking": False}
        if structured:
            response_format = body["response_format"]
            assert response_format["type"] == "json_schema"
            clear_schema = response_format["json_schema"]["schema"]["$defs"]["ModelClearUpdate"]
            assert "evidence" in clear_schema["properties"]
            assert "evidence" not in clear_schema["required"]
        else:
            assert "response_format" not in body
        assert json.loads(body["messages"][1]["content"]) == {
            "text": INTERPRET["text"],
            "conversation_context": [
                {"role": "user", "content": "Подбираю почтовый сервер"},
                {"role": "assistant", "content": "Уточните количество пользователей."},
            ],
            "requirements": INTERPRET["requirements"],
        }
        return completion(RESULT)

    async with client_for(settings, handler) as client:
        response = await client.post("/internal/v1/interpret", json=INTERPRET, headers=AUTH)
    assert response.status_code == 200
    assert response.headers["X-Prompt-Version"] == "interpret-2"
    assert response.json() == RESULT | {"model_version": "release-a"}


async def test_interpret_accepts_clear_quote_and_returns_only_op_and_field(settings):
    clear = {"op": "clear", "field": "edition"}
    quote = "Редакция не важна"
    body = INTERPRET | {"text": f"{INTERPRET['text']}. {quote}."}
    upstream = RESULT | {"updates": [RESULT["updates"][0], clear | {"evidence": quote}]}

    async with client_for(settings, lambda _: completion(upstream)) as client:
        response = await client.post("/internal/v1/interpret", json=body, headers=AUTH)
    assert response.status_code == 200
    assert response.json()["updates"] == [RESULT["updates"][0], clear]


@pytest.mark.parametrize(
    "update, reason",
    [
        (
            {"op": "set", "field": "seats", "value": "50", "evidence": "50 пользователей"},
            "interpretation_schema:",
        ),
        (
            {"op": "set", "field": "seats", "value": 50, "evidence": "фрагмент отсутствует"},
            "set_evidence_not_in_current_message",
        ),
        (
            {"op": "set", "field": "budget_rub", "value": "5,000", "evidence": "50"},
            "interpretation_schema:",
        ),
        (
            {"op": "clear", "field": "edition", "evidence": "Подбираю почтовый сервер"},
            "clear_evidence_not_in_current_message",
        ),
        (
            {"op": "clear", "field": "edition", "evidence": "новая ЛИЦЕНЗИЯ"},
            "clear_evidence_not_in_current_message",
        ),
        (
            {"op": "clear", "field": "edition", "evidence": {"message": "private-model-text"}},
            "interpretation_schema:",
        ),
    ],
)
async def test_interpret_rejects_invalid_model_update_safely(settings, update, reason, caplog):
    async with client_for(settings, lambda _: completion(RESULT | {"updates": [update]})) as client:
        response = await client.post("/internal/v1/interpret", json=INTERPRET, headers=AUTH)
    assert response.status_code == 503
    assert response.json()["code"] == "MODEL_INVALID_OUTPUT"
    assert (
        f"request_id={INTERPRET['request_id']} code=MODEL_INVALID_OUTPUT reason={reason}"
        in caplog.text
    )
    for text in (
        INTERPRET["text"],
        "фрагмент отсутствует",
        "Подбираю почтовый сервер",
        "новая ЛИЦЕНЗИЯ",
        "private-model-text",
    ):
        assert text not in caplog.text


async def test_interpret_logs_invalid_json_as_a_code(settings, caplog):
    upstream = httpx.Response(
        200,
        json={
            "choices": [{"message": {"content": "private-invalid-json"}, "finish_reason": "stop"}]
        },
    )
    async with client_for(settings, lambda _: upstream) as client:
        response = await client.post("/internal/v1/interpret", json=INTERPRET, headers=AUTH)
    assert response.status_code == 503
    assert (
        "request_id=req-interpret code=MODEL_INVALID_OUTPUT "
        "reason=interpretation_schema:json_invalid" in caplog.text
    )
    assert "private-invalid-json" not in caplog.text


async def test_compose_buffers_partial_chunks_and_validates_each_block(settings):
    block = {"text": "Подходит для 50 пользователей.", "fact_ids": ["seats"]}
    encoded = json.dumps(block, ensure_ascii=False)
    upstream = chunk(encoded[:20]) + chunk(encoded[20:] + "\n" + encoded)
    upstream += chunk(None, finish_reason="stop") + "data: [DONE]\n\n"

    def handler(request):
        body = json.loads(request.content)
        assert body["stream"] is True
        assert body["stream_options"] == {"include_usage": True}
        assert body["temperature"] == 0
        assert body["chat_template_kwargs"] == {"enable_thinking": False}
        assert json.loads(body["messages"][1]["content"])["facts"] == COMPOSE["facts"]
        return sse_response(upstream)

    async with client_for(settings, handler) as client:
        response = await client.post("/internal/v1/compose", json=COMPOSE, headers=AUTH)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert events(response) == [
        ("block", block),
        ("block", block),
        ("complete", {"model_version": "release-a", "prompt_version": "compose-1"}),
    ]


@pytest.mark.parametrize(
    "remainder",
    [
        chunk('{"text":"Недостоверно","fact_ids":["unknown"]}\n') + "data: [DONE]\n\n",
        chunk(None, finish_reason="length") + "data: [DONE]\n\n",
        "",
    ],
)
async def test_compose_returns_failed_for_invalid_or_interrupted_stream(settings, remainder):
    valid = chunk('{"text":"До 50.","fact_ids":["seats"]}\n')
    async with client_for(settings, lambda _: sse_response(valid + remainder)) as client:
        response = await client.post("/internal/v1/compose", json=COMPOSE, headers=AUTH)
    result = events(response)
    assert [kind for kind, _ in result] == ["block", "failed"]
    assert result[-1][1]["code"] == "MODEL_INVALID_OUTPUT"


@pytest.mark.parametrize("valid", [True, False])
async def test_interpret_counts_usage_even_if_validation_fails(settings, caplog, valid):
    caplog.set_level("INFO", logger=USAGE_LOGGER)
    result = RESULT if valid else RESULT | {"updates": [{"op": "invalid"}]}
    async with client_for(settings, lambda _: completion(result, usage=USAGE)) as client:
        before = await usage_counters(client, "interpret")
        response = await client.post("/internal/v1/interpret", json=INTERPRET, headers=AUTH)
        after = await usage_counters(client, "interpret")
    assert response.status_code == (200 if valid else 503)
    assert_usage_record(caplog, "interpret", "ok" if valid else "error", USAGE, "req-interpret")
    assert after == before | {
        "input": before["input"] + 41,
        "output": before["output"] + 13,
        "reported": before["reported"] + 1,
    }


@pytest.mark.parametrize(
    "metadata",
    [
        {},
        {"usage": None},
        {"usage": {"prompt_tokens": True, "completion_tokens": 13}},
        {"usage": {"prompt_tokens": 41, "completion_tokens": -1}},
        {"usage": {"prompt_tokens": 10**400, "completion_tokens": 13}},
        {"usage": {"prompt_tokens": 41}},
    ],
)
async def test_interpret_missing_or_invalid_usage_preserves_answer(settings, caplog, metadata):
    caplog.set_level("INFO", logger=USAGE_LOGGER)
    async with client_for(settings, lambda _: completion(RESULT, **metadata)) as client:
        before = await usage_counters(client, "interpret")
        response = await client.post("/internal/v1/interpret", json=INTERPRET, headers=AUTH)
        after = await usage_counters(client, "interpret")
    assert response.status_code == 200
    assert_usage_record(caplog, "interpret", "ok", None, "req-interpret")
    assert after == before | {"missing": before["missing"] + 1}


@pytest.mark.parametrize("usage_events", [1, 2])
async def test_compose_counts_final_usage_once_per_call(settings, caplog, usage_events):
    caplog.set_level("INFO", logger=USAGE_LOGGER)
    block = chunk('{"text":"До 50.","fact_ids":["seats"]}\n')
    upstream = block + usage_event(USAGE) * usage_events + "data: [DONE]\n\n"
    async with client_for(settings, lambda _: sse_response(upstream)) as client:
        before = await usage_counters(client, "compose")
        # A new provider call with the same request_id has its own usage.
        for _ in range(2):
            caplog.clear()
            response = await client.post("/internal/v1/compose", json=COMPOSE, headers=AUTH)
            assert [kind for kind, _ in events(response)] == ["block", "complete"]
            assert_usage_record(caplog, "compose", "ok", USAGE, "req-compose")
        after = await usage_counters(client, "compose")
    assert after == before | {
        "input": before["input"] + 82,
        "output": before["output"] + 26,
        "reported": before["reported"] + 2,
    }


@pytest.mark.parametrize("done", [True, False])
async def test_compose_without_usage_in_complete_or_interrupted_stream(settings, caplog, done):
    caplog.set_level("INFO", logger=USAGE_LOGGER)
    upstream = chunk('{"text":"До 50.","fact_ids":["seats"]}\n')
    if done:
        upstream += "data: [DONE]\n\n"
    async with client_for(settings, lambda _: sse_response(upstream)) as client:
        before = await usage_counters(client, "compose")
        response = await client.post("/internal/v1/compose", json=COMPOSE, headers=AUTH)
        after = await usage_counters(client, "compose")
    assert [kind for kind, _ in events(response)] == ["block", "complete" if done else "failed"]
    assert_usage_record(caplog, "compose", "ok" if done else "error", None, "req-compose")
    assert after == before | {"missing": before["missing"] + 1}


@pytest.mark.parametrize(
    "invalid_block",
    [
        chunk('{"text":"Недостоверно","fact_ids":["unknown"]}\n'),
        chunk(None, finish_reason="length"),
    ],
)
async def test_compose_keeps_final_usage_after_validation_error(settings, caplog, invalid_block):
    caplog.set_level("INFO", logger=USAGE_LOGGER)
    upstream = invalid_block + usage_event(USAGE) + "data: [DONE]\n\n"
    async with client_for(settings, lambda _: sse_response(upstream)) as client:
        before = await usage_counters(client, "compose")
        response = await client.post("/internal/v1/compose", json=COMPOSE, headers=AUTH)
        after = await usage_counters(client, "compose")
    [(kind, error)] = events(response)
    assert kind == "failed" and error["code"] == "MODEL_INVALID_OUTPUT"
    assert_usage_record(caplog, "compose", "error", USAGE, "req-compose")
    assert after == before | {
        "input": before["input"] + 41,
        "output": before["output"] + 13,
        "reported": before["reported"] + 1,
    }


async def test_provider_error_contains_no_upstream_payload(settings):
    async with client_for(
        settings, lambda _: httpx.Response(429, text="private provider text")
    ) as client:
        response = await client.post("/internal/v1/interpret", json=INTERPRET, headers=AUTH)
    assert response.status_code == 503
    assert response.json()["code"] == "MODEL_UNAVAILABLE"
    assert "private provider text" not in response.text


@pytest.mark.parametrize("remaining_ms, seconds", [(28_000, 28), (119_000, 119), (160_000, 120)])
async def test_deadline_uses_remaining_budget_up_to_service_limit(remaining_ms, seconds):
    clock = asyncio.get_running_loop().time
    started = clock()
    expires = make_deadline(remaining_ms)
    assert started + seconds <= expires <= clock() + seconds


@pytest.mark.parametrize("path, body", [("interpret", INTERPRET), ("compose", COMPOSE)])
async def test_deadline_bounds_upstream_wait(settings, path, body):
    async def slow_provider(_):
        await asyncio.sleep(2)
        pytest.fail("FastAPI did not cancel the provider wait")

    async with client_for(settings, slow_provider) as client:
        response = await client.post(
            f"/internal/v1/{path}", json=body | {"deadline_ms": 25}, headers=AUTH
        )
    if path == "compose":
        [(kind, error)] = events(response)
        assert kind == "failed"
    else:
        assert response.status_code == 503
        error = response.json()
    assert error["code"] == "MODEL_TIMEOUT"


async def test_waiting_for_provider_slot_counts_toward_deadline(settings, caplog):
    caplog.set_level("INFO", logger=USAGE_LOGGER)
    started = asyncio.Event()
    finish = asyncio.Event()
    calls = 0

    async def handler(_):
        nonlocal calls
        calls += 1
        started.set()
        await finish.wait()
        return completion(RESULT)

    async with client_for(settings, handler) as client:
        first = asyncio.create_task(
            client.post("/internal/v1/interpret", json=INTERPRET, headers=AUTH)
        )
        try:
            await asyncio.wait_for(started.wait(), timeout=1)
            response = await client.post(
                "/internal/v1/interpret",
                json=INTERPRET | {"request_id": "queued", "deadline_ms": 25},
                headers=AUTH,
            )
        finally:
            finish.set()
            first_response = await first

    assert first_response.status_code == 200
    assert response.status_code == 503
    assert response.json()["code"] == "MODEL_TIMEOUT"
    assert calls == 1
    assert_usage_record(caplog, "interpret", "ok", None, "req-interpret")


@pytest.mark.parametrize("asgi_version", ["2.3", "2.4"])
async def test_stream_disconnect_closes_provider_and_releases_slot(settings, asgi_version, caplog):
    caplog.set_level("INFO", logger=USAGE_LOGGER)
    class HangingStream(httpx.AsyncByteStream):
        closed = False

        async def __aiter__(self):
            yield chunk('{"text":"До 50.","fact_ids":["seats"]}\n').encode("utf-8")
            await asyncio.sleep(3)

        async def aclose(self):
            self.closed = True

    upstream = HangingStream()

    def handler(_):
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=upstream)

    async def disconnect():
        app = create_app(settings, runpod_transport=httpx.MockTransport(handler))
        inbox = asyncio.Queue()
        inbox.put_nowait({"type": "http.request", "body": json.dumps(COMPOSE).encode()})
        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": asgi_version},
            "method": "POST",
            "path": "/internal/v1/compose",
            "query_string": b"",
            "headers": [
                (b"authorization", b"Bearer service-test"),
                (b"content-type", b"application/json"),
            ],
        }

        async def send(message):
            if b"event: block" in message.get("body", b""):
                inbox.put_nowait({"type": "http.disconnect"})
                if asgi_version == "2.4":
                    raise OSError("Connection closed")

        async with app.router.lifespan_context(app):
            async with asyncio.timeout(2):
                if asgi_version == "2.4":
                    with pytest.raises(ExceptionGroup) as disconnect_group:
                        await app(scope, inbox.get, send)
                    assert isinstance(disconnect_group.value.exceptions[0], ClientDisconnect)
                else:
                    await app(scope, inbox.get, send)
            assert upstream.closed
            assert not app.state.runpod.slots.locked()

    await disconnect()
    assert_usage_record(caplog, "compose", "error", None, "req-compose")
