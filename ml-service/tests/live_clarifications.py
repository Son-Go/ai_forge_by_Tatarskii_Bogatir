"""Evaluate the configured model via FastAPI using only synthetic conversations."""

import argparse
import asyncio
import json
from dataclasses import dataclass, field
from typing import Literal
from uuid import uuid4

import httpx

from app.config import Settings
from app.main import create_app
from app.prompts import INTERPRET_PROMPTS
from app.schemas import Intent, RequirementField, Requirements

ACTIVATION_HISTORY = [
    {"role": "user", "text": "Система не принимает мой ключ."},
    {"role": "assistant", "text": "Скопируйте ключ из раздела «Лицензии» в личном кабинете."},
]
PRICE_HISTORY = [{"role": "assistant", "text": "Цена за лицензию составляет 1000 RUB."}]

SIGNAL_CASES = [
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
    ("deferral-info", "Можно узнать условия отсрочки оплаты?", [], set()),
    ("deferral-info-comma", "Подскажите, на каких условиях предоставляется отсрочка?", [], set()),
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


@dataclass
class InterpretCase:
    label: str
    text: str
    intent: Intent
    history: list[dict[str, str]] = field(default_factory=list)
    requirements: Requirements = field(default_factory=dict)
    product: str | None = None
    values: Requirements = field(default_factory=dict)
    signals: set[str] = field(default_factory=set)
    candidates: frozenset[RequirementField] = frozenset()


MAIL_HISTORY = [
    {"role": "user", "text": "Подберите продление MDaemon на 50 пользователей."},
    {"role": "assistant", "text": "Нашёл продление MDaemon на год."},
]
MAIL_REQUIREMENTS: Requirements = {
    "product_name": "MDaemon",
    "seats": 50,
    "license_kind": "renewal",
    "license_term_months": 12,
}
SOLUTION_CANDIDATES: frozenset[RequirementField] = frozenset(
    {"license_kind", "license_term_months"}
)

INTERPRET_CASES = [
    InterpretCase(label, text, "product_question", history=history, signals=signals)
    for label, text, history, signals in SIGNAL_CASES
] + [
    InterpretCase(
        "card-payment", "Отсрочку не хочу, можно оплатить сразу картой?", "product_question"
    ),
    InterpretCase(
        "card-paraphrase",
        "Платить позднее нам не нужно. Принимаете банковские карты?",
        "product_question",
    ),
    InterpretCase(
        "other-product",
        "А для какой ОС подходит The Bat! Professional?",
        "product_question",
        history=MAIL_HISTORY,
        requirements=MAIL_REQUIREMENTS,
        product="The Bat! Professional",
    ),
    InterpretCase(
        "other-product-paraphrase",
        "Пока уточню: The Bat! Professional запускается на Linux?",
        "product_question",
        history=MAIL_HISTORY,
        requirements=MAIL_REQUIREMENTS,
        product="The Bat! Professional",
    ),
    InterpretCase(
        "family-edition",
        "Нужно продление MDaemon Standard на 50 пользователей на год",
        "known_product",
        product="MDaemon",
        values={
            "product_name": "MDaemon",
            "edition": "Standard",
            "license_kind": "renewal",
            "seats": 50,
            "license_term_months": 12,
        },
    ),
    InterpretCase(
        "family-edition-paraphrase",
        "Продлите на двенадцать месяцев MDaemon в редакции Standard, пятьдесят пользователей.",
        "known_product",
        product="MDaemon",
        values={
            "product_name": "MDaemon",
            "edition": "Standard",
            "license_kind": "renewal",
            "seats": 50,
            "license_term_months": 12,
        },
    ),
    InterpretCase(
        "solution-preference",
        "Нужна защита рабочих станций для 35 сотрудников. Windows, "
        "локально, желательно из реестра российского ПО.",
        "needs_solution",
        values={
            "use_case": "защита рабочих станций",
            "seats": 35,
            "platform": "Windows",
            "deployment": "on_prem",
        },
        candidates=SOLUTION_CANDIDATES,
    ),
    InterpretCase(
        "solution-preference-paraphrase",
        "Подберите резервное копирование для 30 пользователей "
        "под Linux на своём сервере. Запись в реестре была бы плюсом.",
        "needs_solution",
        values={
            "use_case": "резервное копирование",
            "seats": 30,
            "platform": "Linux",
            "deployment": "on_prem",
        },
        candidates=SOLUTION_CANDIDATES,
    ),
    InterpretCase(
        "cloud-required-registry",
        "Подберите защиту почты в облаке на 40 человек. Обязательно из реестра российского ПО.",
        "needs_solution",
        values={
            "use_case": "защита почты",
            "seats": 40,
            "deployment": "cloud",
            "domestic_required": True,
        },
        candidates=SOLUTION_CANDIDATES,
    ),
    InterpretCase(
        "correct-seats",
        "Нет, нужно на 20 пользователей, остальное так же.",
        "known_product",
        history=MAIL_HISTORY,
        requirements=MAIL_REQUIREMENTS,
        product="MDaemon",
        values={"seats": 20},
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


async def evaluate(
    cold_deadline_ms: int,
    version: Literal["interpret-5", "interpret-6"] | None,
    interpret_only: bool,
) -> int:
    settings = Settings()
    if version is not None:
        settings.ml_interpret_prompt_version = version
    if settings.ml_service_token is None:
        print("ML_SERVICE_TOKEN is missing")
        return 1
    app = create_app(settings)
    headers = {"Authorization": f"Bearer {settings.ml_service_token.get_secret_value()}"}
    failures = 0
    reported_models: dict[str, str] = {}

    async def capture_model(response: httpx.Response) -> None:
        if not response.is_success:
            return
        # Interpret uses a JSON completion directly or inside the completed queue job.
        await response.aread()
        try:
            payload = response.json()
        except ValueError:
            return
        if settings.runpod_request_mode == "queue":
            if not isinstance(payload, dict) or payload.get("status") != "COMPLETED":
                return
            payload = payload.get("output")
            if isinstance(payload, list) and len(payload) == 1:
                payload = payload[0]
        if isinstance(payload, dict) and isinstance(payload.get("model"), str):
            reported_models[response.request.headers["X-Request-Id"]] = payload["model"]

    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver", headers=headers
        ) as client,
    ):
        if (await client.get("/health/ready")).status_code != 200:
            print("The configured model profile is not ready")
            return 1

        cold_deadline_ms = min(settings.model_deadline_limit_ms, cold_deadline_ms)
        print(
            f"Running synthetic cases: model={settings.runpod_model}, "
            f"release={settings.runpod_model_version}, "
            f"prompt={settings.ml_interpret_prompt_version}, "
            f"mode={settings.runpod_request_mode}, format={settings.runpod_response_format}, "
            f"cold_deadline_ms={cold_deadline_ms}"
        )
        hooks = app.state.runpod.http.event_hooks["response"]
        hooks.append(capture_model)
        for index, case in enumerate(INTERPRET_CASES):
            request_id = f"live-{uuid4()}"
            response = await client.post(
                "/internal/v1/interpret",
                json={
                    "request_id": request_id,
                    "deadline_ms": cold_deadline_ms if index == 0 else 120_000,
                    "text": case.text,
                    "conversation_context": case.history,
                    "requirements": case.requirements,
                },
            )
            if response.status_code != 200:
                code = response.json().get("code")
                print(
                    f"FAIL {case.label} request_id={request_id}: HTTP {response.status_code} {code}"
                )
                if code != "MODEL_INVALID_OUTPUT":
                    return 1
                failures += 1
                continue
            result = response.json()
            updates = result["updates"]
            signals = result["signals"]
            actual_model = reported_models.pop(request_id, None)
            prompt_version = response.headers["X-Prompt-Version"]
            checks = {
                "json": True,
                "intent": result["intent"] == case.intent,
                "product": result["product_query"] == case.product,
                "updates": len(updates) == len(case.values)
                and all(u["op"] == "set" for u in updates)
                and {u["field"]: u["value"] for u in updates} == case.values,
                "evidence": all(u.get("evidence") and u["evidence"] in case.text for u in updates)
                and all(s["evidence"] in case.text for s in signals),
                "clarifications": case.candidates.issuperset(result["clarification_candidates"]),
                "signals": {s["kind"] for s in signals} == case.signals,
                "profile": actual_model == settings.runpod_model
                and result["model_version"] == settings.runpod_model_version
                and prompt_version == settings.ml_interpret_prompt_version,
            }
            failed = [name for name, passed in checks.items() if not passed]
            print(
                f"{'FAIL' if failed else 'PASS'} {case.label} request_id={request_id} "
                f"prompt={prompt_version} release={result['model_version']} model={actual_model!r} "
                f"checks={','.join(failed) if failed else 'all'}"
            )
            failures += bool(failed)
        hooks.remove(capture_model)

        compose_cases = [] if interpret_only else COMPOSE_CASES
        for label, fact, expected in compose_cases:
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

    total = len(INTERPRET_CASES) + len(compose_cases)
    print(f"Configured model: {total - failures}/{total} checks passed")
    return int(failures > 0)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cold-deadline-ms", type=int, default=300_000)
    parser.add_argument("--interpret-version", choices=INTERPRET_PROMPTS)
    parser.add_argument("--interpret-only", action="store_true")
    args = parser.parse_args()
    if args.cold_deadline_ms < 1:
        parser.error("--cold-deadline-ms must be positive")
    raise SystemExit(
        asyncio.run(evaluate(args.cold_deadline_ms, args.interpret_version, args.interpret_only))
    )
