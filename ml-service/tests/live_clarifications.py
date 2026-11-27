"""Evaluate the configured model via FastAPI using only synthetic conversations."""

import asyncio
import json
from uuid import uuid4

import httpx

from app.config import Settings
from app.main import create_app

ACTIVATION_HISTORY = [
    {"role": "user", "text": "Система не принимает мой ключ."},
    {"role": "assistant", "text": "Скопируйте ключ из раздела «Лицензии» в личном кабинете."},
]
PRICE_HISTORY = [{"role": "assistant", "text": "Цена за лицензию составляет 1000 RUB."}]

INTERPRET_CASES = [
    ("delivery", "Ключ не пришёл", [], {"key_delivery"}),
    ("delivery-paraphrase", "Покупку оплатил, а письма с лицензией всё нет.", [], {"key_delivery"}),
    ("activation", "Система не принимает полученный ключ.", [], {"key_activation"}),
    ("refund", "Как вернуть уже оплаченную лицензию?", [], {"refund"}),
    ("guide-failed", "Не помогло", ACTIVATION_HISTORY, {"instruction_failed"}),
    (
        "guide-paraphrase",
        "Попробовали, результат тот же.",
        ACTIVATION_HISTORY,
        {"instruction_failed"},
    ),
    ("no-stale-signal", "Спасибо, теперь всё работает.", ACTIVATION_HISTORY, set()),
    ("price-objection", "Мне дорого", PRICE_HISTORY, {"price_objection"}),
    ("price-paraphrase", "Для нас эта сумма слишком высока.", PRICE_HISTORY, {"price_objection"}),
    ("price-question", "Сколько стоит?", [], set()),
    ("coupon-only", "У меня есть купон.", PRICE_HISTORY, set()),
    ("deferral", "Хочу отсрочку", [], {"payment_deferral"}),
    ("deferral-paraphrase", "Можно заплатить после поставки?", [], {"payment_deferral"}),
    ("payment-question", "Какие способы оплаты?", [], set()),
    ("deferral-negated", "Отсрочка нам не нужна.", [], set()),
    (
        "combined",
        "Дорого, можно заплатить позже?",
        PRICE_HISTORY,
        {"price_objection", "payment_deferral"},
    ),
    (
        "combined-30-days",
        "Мне дорого, можно рассчитаться через 30 дней?",
        PRICE_HISTORY,
        {"price_objection", "payment_deferral"},
    ),
]

COMPOSE_CASES = [
    (
        "guide",
        "Скопируйте ключ из раздела «Лицензии» в личном кабинете.",
        ("Лицензии", "личном кабинете"),
    ),
    (
        "sale",
        "Базовая цена — 1000 RUB за единицу. Скидка — 5%. Итог — 950 RUB за единицу.",
        ("1000 RUB", "5%", "950 RUB"),
    ),
]


async def evaluate() -> int:
    settings = Settings()
    if settings.ml_service_token is None:
        print("ML_SERVICE_TOKEN is missing")
        return 1
    app = create_app(settings)
    headers = {"Authorization": f"Bearer {settings.ml_service_token.get_secret_value()}"}
    failures = 0
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver", headers=headers
        ) as client,
    ):
        if (await client.get("/health/ready")).status_code != 200:
            print("The configured model profile is not ready")
            return 1

        cold_deadline_ms = min(settings.model_deadline_limit_ms, 300_000)
        print(
            f"Running synthetic cases: model={settings.runpod_model_version}, "
            f"mode={settings.runpod_request_mode}, format={settings.runpod_response_format}"
        )
        for index, (label, utterance, history, expected) in enumerate(INTERPRET_CASES):
            response = await client.post(
                "/internal/v1/interpret",
                json={
                    "request_id": f"live-{uuid4()}",
                    "deadline_ms": cold_deadline_ms if index == 0 else 120_000,
                    "text": utterance,
                    "conversation_context": history,
                    "requirements": {},
                },
            )
            if response.status_code != 200:
                code = response.json().get("code")
                print(f"FAIL {label}: HTTP {response.status_code} {code}")
                if code != "MODEL_INVALID_OUTPUT":
                    return 1
                failures += 1
                continue
            signals = response.json()["signals"]
            actual = {signal["kind"] for signal in signals}
            passed = actual == expected and all(s["evidence"] in utterance for s in signals)
            status = "PASS" if passed else "FAIL"
            prompt_version = response.headers["X-Prompt-Version"]
            print(
                f"{status} {label} ({prompt_version}): "
                f"{sorted(actual)}; expected {sorted(expected)}"
            )
            failures += not passed

        for label, fact, expected in COMPOSE_CASES:
            response = await client.post(
                "/internal/v1/compose",
                json={
                    "request_id": f"live-{uuid4()}",
                    "deadline_ms": 120_000,
                    "outcome": "answer",
                    "language": "ru",
                    "facts": [{"id": label, "text": fact}],
                },
            )
            if response.status_code != 200:
                print(f"FAIL {label}: HTTP {response.status_code} {response.json().get('code')}")
                return 1
            blocks = []
            completion = None
            for frame in response.text.split("\n\n"):
                if frame.startswith("event: block\n"):
                    blocks.append(json.loads(frame.splitlines()[1].removeprefix("data: ")))
                if frame.startswith("event: complete\n"):
                    completion = json.loads(frame.splitlines()[1].removeprefix("data: "))
            text = " ".join(block["text"] for block in blocks)
            passed = completion is not None and all(value in text for value in expected)
            prompt_version = completion["prompt_version"] if completion else "incomplete"
            print(f"{'PASS' if passed else 'FAIL'} compose-{label} ({prompt_version})")
            failures += not passed

    total = len(INTERPRET_CASES) + len(COMPOSE_CASES)
    print(f"Configured model: {total - failures}/{total} checks passed")
    return int(failures > 0)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(evaluate()))
