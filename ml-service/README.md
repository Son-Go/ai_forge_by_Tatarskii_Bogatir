# Внутренний ML-сервис Softline

Spring Boot вызывает FastAPI по адресу `http://ml-service:8000` в сети Compose. FastAPI формирует промпты, отправляет запросы в RunPod Serverless и валидирует ответы. Spring Boot ведёт сессии и каталог, проверяет коммерческие утверждения и обслуживает публичный API. [Внутренний OpenAPI](../contracts/internal.openapi.yaml).

- `POST /internal/v1/interpret` возвращает намерение и изменения требований. Поле `model_version` содержит версию релиза, заголовок `X-Prompt-Version` — версию промпта.
- `POST /internal/v1/compose` возвращает SSE. Каждое событие `block` содержит законченный текст и ссылки на факты этого запроса. Поток завершается `complete` с версиями или `failed` с кодом ошибки. Spring Boot сверяет смысл утверждений с источниками перед отправкой текста в чат.
- `GET /health/live` проверяет процесс. `GET /health/ready` проверяет загрузку локальной конфигурации. Оба маршрута работают без вызова GPU.

Модельные запросы требуют `Authorization: Bearer <ML_SERVICE_TOKEN>`, `request_id` и остаток дедлайна `deadline_ms`. В Spring Boot на весь ход по умолчанию отводится 120 секунд. FastAPI использует переданный остаток с верхней границей 120 секунд. Ожидание свободного слота, холодный запуск RunPod и генерация расходуют этот бюджет.

Ошибка входа возвращается с HTTP 400, ошибка авторизации — 401, проблема модели до начала потока — 503. Коды `MODEL_TIMEOUT`, `MODEL_UNAVAILABLE` и `MODEL_INVALID_OUTPUT` также передаются в SSE `failed`, если поток уже открыт. Закрытие внутреннего SSE закрывает соединение с RunPod. Обработку повторов хода выполняет Java.

## Профиль RunPod

1. Разверните RunPod Serverless endpoint на vLLM. Для базовой проверки подходит `MODEL_NAME=Qwen/Qwen3-32B-AWQ`. Для командного релиза укажите репозиторий AWQ-весов и зафиксируйте `MODEL_REVISION`. При использовании приватных весов передайте `HF_TOKEN` через секреты RunPod. [Переменные воркера vLLM](https://docs.runpod.io/serverless/vllm/environment-variables).
2. Скопируйте `.env.example` в `.env` внутри `ml-service`. Заполните `RUNPOD_ENDPOINT_ID` и `RUNPOD_API_KEY`, задайте собственное значение `ML_SERVICE_TOKEN` и используйте его в Spring Boot. `RUNPOD_MODEL` соответствует имени из RunPod, `RUNPOD_MODEL_VERSION` идентифицирует релиз для журнала. FastAPI вызывает `https://api.runpod.ai/v2/<endpoint_id>/openai/v1/chat/completions`. [OpenAI-совместимый API RunPod](https://docs.runpod.io/serverless/vllm/openai-compatibility).
3. Используйте шаблон модели с поддержкой `enable_thinking`. FastAPI передаёт `chat_template_kwargs: {"enable_thinking": false}` и `temperature: 0` в каждом запросе `interpret` и `compose`. [Параметры запроса vLLM](https://docs.vllm.ai/en/latest/features/reasoning_outputs/#request-level-override).
В локальном стенде с Runpod Serverless и долгой очередью задайте `RUNPOD_REQUEST_MODE=queue`, `CHAT_TURN_TIMEOUT_MS=1200000` и `CHAT_COLD_TURN_TIMEOUT_MS=1200000` в корневом `.env`. ML отправляет каждую задачу vLLM один раз через `/run`, использует оставшийся бюджет хода для TTL и читает результат через `/status`. Для композиции готовый текст разбирается на проверенные блоки и передаётся по внутреннему SSE. Учёт токенов использует `usage` из завершённой задачи. Для этого режима нужен совместимый worker-vLLM. [Операции очереди Runpod](https://docs.runpod.io/serverless/endpoints/operation-reference)

4. Начните с `RUNPOD_RESPONSE_FORMAT=prompt`. Сервис запрашивает JSON в промпте и проверяет его схемой. После проверки совместимости выбранного воркера можно задать `RUNPOD_RESPONSE_FORMAT=json_schema` для `interpret`. Модельный поток `compose` использует один JSON-объект на строку. [Структурированные ответы vLLM](https://docs.vllm.ai/en/latest/features/structured_outputs/).

`RUNPOD_MAX_CONCURRENCY` ограничивает параллельные вызовы на процесс FastAPI. `ML_MAX_CONTEXT_BYTES` ограничивает размер сериализованного контекста. При изменении контекстного окна RunPod учитывайте системный промпт и лимит генерации.

## Запуск

Локально на Python 3.13 из каталога `ml-service`.

```sh
uv sync --locked
uv run --locked --env-file .env uvicorn app.main:app
curl --fail http://127.0.0.1:8000/health/ready
```

В Compose из корня проекта. Тот же файл можно передать вторым аргументом `-f` после основного Compose команды. Порт FastAPI доступен в сети Compose.

```sh
docker compose --env-file ml-service/.env -f infra/compose.ml.yaml up --build -d
docker compose --env-file ml-service/.env -f infra/compose.ml.yaml ps
```

## Проверки

Локальные тесты используют имитацию транспортного уровня RunPod.

```sh
uv run --locked pytest
uv run --locked ruff check .
```

После развёртывания модели выполните оба запроса на синтетических данных, используя сервисный токен в переменной `ML_SERVICE_TOKEN`. Повторите после остановки воркера и после прогрева. Успешный первый запрос возвращает JSON с `model_version`, второй — хотя бы один `block` и завершающий `complete`.

```sh
curl --fail-with-body http://127.0.0.1:8000/internal/v1/interpret \
  -H "Authorization: Bearer ${ML_SERVICE_TOKEN}" -H 'Content-Type: application/json' \
  --data '{"request_id":"smoke-interpret","deadline_ms":120000,"text":"Нужна новая лицензия MDaemon на 50 пользователей","conversation_context":[],"requirements":{}}'

curl --fail-with-body --no-buffer http://127.0.0.1:8000/internal/v1/compose \
  -H "Authorization: Bearer ${ML_SERVICE_TOKEN}" -H 'Content-Type: application/json' \
  --data '{"request_id":"smoke-compose","deadline_ms":120000,"outcome":"answer","language":"ru","facts":[{"id":"demo-seats","text":"В примере один пакет покрывает 50 пользователей."}]}'
```
