# Закрытая панель Runpod Serverless

Панель управляет одним существующим эндпоинтом. Она работает в Compose-проекте `forge-runpod-panel` со своей сетью и томом `state`. Контейнер запускается от непривилегированного пользователя, слушает loopback VPS через опубликованный порт и ограничен 0,5 CPU, 192 МиБ RAM и 64 процессами. Caddy и основной Compose о панели не знают.

## Настройка на VPS

Из корня репозитория создайте отдельный файл окружения.

```sh
(umask 077 && cp runpod-panel/.env.example runpod-panel/.env)
openssl rand -hex 32
```

Заполните файл на сервере. Используйте отдельный пароль оператора и ключи Runpod с минимальными правами для аккаунта или команды, которой принадлежит эндпоинт. Compose передаёт эти настройки процессу панели. Доступ к Docker на VPS даёт доступ к окружению контейнера.

| Переменная | Назначение |
| --- | --- |
| `PANEL_ENDPOINT_ID` | Обязательный ID существующего эндпоинта. Операции браузера не могут его переопределить. |
| `PANEL_MANAGEMENT_KEY` | Обязательный ключ Runpod с `serverless:read` и `serverless:write` для чтения конфигурации, метрик, воркеров и PATCH. |
| `PANEL_BILLING_KEY` | Ключ с `billing:read` для расходов конкретного эндпоинта и баланса аккаунта. Пустое значение отключает оба запроса. Можно указать тот же ключ, если он выдан с этими правами. |
| `PANEL_INFERENCE_KEY`, `PANEL_MODEL` | Ключ с правом вызова выбранного эндпоинта и точное имя обслуживаемой vLLM модели. Заполняются вместе. Для проверки используется OpenAI-совместимый `chat/completions`. |
| `PANEL_OPERATOR_USER`, `PANEL_OPERATOR_PASSWORD` | Пользователь Basic Auth, по умолчанию `operator`, и пароль длиной от 24 печатных ASCII-символов. |
| `PANEL_PORT`, `PANEL_PROBE_TIMEOUT_SECONDS` | Loopback-порт панели на VPS, по умолчанию 8765, и дедлайн тестового запроса в секундах, по умолчанию 960 с для очереди. Для балансировки ожидание ограничено 120 с. |
| `PANEL_ACTIVE_USD_PER_WORKER_HOUR`, `PANEL_FLEX_USD_PER_WORKER_HOUR`, `PANEL_RATE_SOURCE` | Ставки в USD за час работы целого воркера и краткий источник с датой. Возьмите ставки текущего GPU и режима у Runpod. Для воркера с несколькими GPU учтите стоимость всего воркера. Пустая ставка отображается как недоступная. |
| `PANEL_ML_CONCURRENCY` | Необязательная справочная копия фактического `RUNPOD_MAX_CONCURRENCY` на VPS. Переменная панели не управляет ML. |
| `PANEL_GRAFANA_URL` | Ссылка на Grafana с точки зрения браузера, по умолчанию `http://127.0.0.1:3000/d/runpod-token-usage`. |

Ключи Runpod передаются провайдеру в заголовках. Интерфейс получает только разрешённые поля. Runpod REST заменяет карту `env` целиком и не гарантирует сохранение скрытых значений при чтении и последующей записи. Открывайте консоль Runpod для изменений переменных, в панели доступны их имена. [Управление ключами](https://docs.runpod.io/get-started/api-keys) · [REST v2 PATCH эндпоинта](https://docs.runpod.io/api-reference-v2/serverless/update-a-serverless-endpoint)

## Запуск, доступ, обновление и остановка

Проверьте, что порт свободен и VPS может обращаться к `api.runpod.io` и `api.runpod.ai` по HTTPS. Запустите отдельный проект.

```sh
docker compose --env-file runpod-panel/.env -f runpod-panel/compose.yaml -p forge-runpod-panel config --quiet
docker compose --env-file runpod-panel/.env -f runpod-panel/compose.yaml -p forge-runpod-panel up -d --build --wait
docker compose --env-file runpod-panel/.env -f runpod-panel/compose.yaml -p forge-runpod-panel ps
curl --fail http://127.0.0.1:8765/healthz
```

Откройте SSH-туннель на машине оператора. Второе перенаправление нужно для ссылки на Grafana. Если порт на VPS отличается, обновите правую часть нужного перенаправления.

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:8765:127.0.0.1:8765 \
  -L 127.0.0.1:3000:127.0.0.1:3000 user@vps
```

Откройте [панель](http://127.0.0.1:8765/) и войдите под учётной записью оператора. Держите публикацию на loopback и используйте SSH для доступа. После обновления исходников повторите `up -d --build --wait`. Штатная остановка сохраняет том.

```sh
docker compose --env-file runpod-panel/.env -f runpod-panel/compose.yaml -p forge-runpod-panel stop
```

При остановленной панели таймер ждёт следующего запуска. Если срок уже прошёл, панель сразу перечитает конфигурацию Runpod и попытается подтвердить возврат. Если панель нужно надолго выключить, а прогрев активен, сначала проверьте настроенный минимум воркеров. Сохраняйте том при обновлениях и резервном копировании. Перед сменой `PANEL_ENDPOINT_ID` завершите прогрев старого эндпоинта.

## Как интерпретировать данные

- Для эндпоинта с очередью «Обзор» использует `/health` для готовых, запускающихся и проблемных воркеров и отдельно показывает запущенных воркеров и запросы в работе. Число занятых сверяется по статусу `RUNNING` из REST v2 и наличию задач в работе. Записи `IDLE` без времени работы исключаются из готовых. Записи старой версии указаны отдельно. Часовые графики используют завершившиеся запросы, ошибки, p95 выполнения и ожидания, число холодных стартов. Если Runpod не вернул интервалы, график не подставляет нули. Последняя точка старше двух часов отмечается как устаревшая. [Воркеры](https://docs.runpod.io/api-reference-v2/serverless/list-serverless-endpoint-workers) · [Метрики запросов](https://docs.runpod.io/api-reference-v2/serverless/get-serverless-endpoint-request-metrics) · [Метрики холодных стартов](https://docs.runpod.io/api-reference-v2/serverless/get-serverless-endpoint-cold-start-metrics)
- «Проверить ответ» явно вызывает модель. Для эндпоинта с очередью панель отправляет короткий запрос через `/run` и опрашивает `/status`. По умолчанию задача живёт до 16 минут, интерфейс показывает состояние очереди и выполнения. Новая проверка во время ожидания открывает статус текущей задачи. После перезапуска панели отслеживание этой пробы прекращается, срок жизни задачи на стороне Runpod сохраняется. Проба обращается напрямую к Runpod. Grafana показывает токены вызовов локального ML-сервиса чата. Фоновый опрос и healthcheck модель не вызывают. В проекте используется vLLM с отключённым thinking. [Операции очереди Runpod](https://docs.runpod.io/serverless/endpoints/operation-reference) · [Входные данные worker-vLLM](https://github.com/runpod-workers/worker-vllm/blob/main/src/handler.py)
- Панель последовательно выполняет изменения. Она перечитывает конфигурацию перед PATCH и после него. При неизвестном результате повторяются только чтения. Если спустя минуту нужная конфигурация ещё не видна, «Сверить состояние Runpod» снова читает настройки и позволяет вернуться к предпросмотру. У REST v2 нет документированной атомарной условной записи. Изменение вне панели между последним GET и PATCH может остаться незамеченным. Перед тестом предупредите других операторов и избегайте одновременной записи.
- Таймер хранит момент истечения, отпечаток применённой конфигурации и сведения о незавершённой записи. Он сохраняет максимум воркеров и возвращает только минимум. При обнаружении расхождения автоматический возврат прекращается. Изменение минимума вручную или выбор профиля отменяет таймер после подтверждения операции.
- «Расходы» берутся из биллинга выбранного эндпоинта за сегодня, 7 и 30 дней, включая незавершённые сутки UTC. Суммы отражают только данные Runpod, и отдельные дни могут поступать с задержкой. Баланс относится ко всему аккаунту. Оценка режима использует введённые ставки и показывается в подтверждении отдельно от биллинга. [Биллинг Serverless](https://docs.runpod.io/api-reference-v2/billing/get-serverless-billing-history) · [Баланс](https://docs.runpod.io/api-reference-v2/billing/get-the-account-balance) · [Тарификация](https://docs.runpod.io/serverless/pricing)

## Воспроизводимая локальная проверка

Серверные тесты используют подмену транспорта HTTPX и временную SQLite.

```sh
uv run --directory runpod-panel --locked ruff check .
uv run --directory runpod-panel --locked pytest -q
```

Для браузерной проверки установите зависимости в `frontend/` по его README. Запустите контейнер панели с локальным имитатором из `tests/`. Все ключи и пароли в файлах тестового стенда синтетические. Команды ниже запускаются из корня.

```sh
panel_test() {
  PANEL_FIXTURES="$PWD/runpod-panel/tests" docker compose \
    --env-file runpod-panel/tests/panel.env \
    -f runpod-panel/compose.yaml -f runpod-panel/tests/panel.compose.yaml \
    -p forge-runpod-panel-check "$@"
}
stack_test() {
  STACK_FIXTURES="$PWD/runpod-panel/tests/stack" docker compose \
    --env-file runpod-panel/tests/stack/stack.env \
    -f compose.yaml -f runpod-panel/tests/stack/compose.yaml \
    -p forge-panel-stack-check "$@"
}

docker compose --env-file infra/.env.example config --format json | shasum -a 256
panel_test up -d --build --wait
node runpod-panel/tests/browser.mjs
stack_test up -d --build --wait
python3 runpod-panel/tests/stack_smoke.py on
panel_test stop
python3 runpod-panel/tests/stack_smoke.py off
docker compose --env-file infra/.env.example config --format json | shasum -a 256
stack_test down
panel_test down
```

Укажите `PANEL_CHROME_BIN`, если используете установленный Google Chrome вместо Chromium Playwright. `PANEL_SCREENSHOTS` задаёт каталог снимков проверки. Чат проверяется с синтетическим XML-каталогом через действующие Caddy, Spring Boot и ML-сервис. Подменены только ответы Runpod. Grafana через Loki проверяется по `request_id` для этапов интерпретации и композиции.

## Приёмка перед выкладкой

На явно выделенном тестовом эндпоинте проверьте реальные права ключей, чтение метрик и биллинга, ставки, валидацию и видимость конфигурации после PATCH. До проверки прогрева убедитесь, что контейнер может писать в отдельный том и что выбранный тестовый аккаунт допускает расходы. Для рабочего endpoint на VPS сначала проверьте порт, SSH-туннель, healthcheck панели, чтение конфигурации и независимую готовность чата. Прогон этой ветки использовал имитатор Runpod и локальный тестовый стек.
