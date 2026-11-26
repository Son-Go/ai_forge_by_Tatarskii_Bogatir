# Локальный запуск

Для тестовой сборки образов используйте пример окружения напрямую. Поля для ключа RunPod и сервисных токенов в примере оставлены пустыми.

```sh
docker compose --env-file infra/.env.example build
```

При первом локальном запуске скопируйте `infra/.env.example` в `.env` в корне репозитория и задайте пароль PostgreSQL. Корневой `.env` исключён из Git. Проверьте конфигурацию и запустите сборку из корня проекта.

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
curl --fail http://localhost:8080/health/live
```

Корневой Compose собирает цели `backend`, `ml-service` и `caddy` из общего [Dockerfile](../Dockerfile) и запускает PostgreSQL из образа `postgres:17`. Образ Caddy собирает фронтенд из зафиксированных зависимостей и раздаёт его по адресу `http://localhost:8080`. Flyway применяет схему при старте Java. `/health/ready` показывает `200` после появления активного снимка каталога.

Для проверки RunPod на синтетических данных заполните `RUNPOD_API_KEY`, `RUNPOD_ENDPOINT_ID`, имя модели на endpoint в `RUNPOD_MODEL` и метку её версии в `RUNPOD_MODEL_VERSION`. Задайте отдельный токен внутреннего HTTP API в `ML_SERVICE_TOKEN`. Проверочные запросы к FastAPI описаны в инструкции ML-сервиса. [Настройки FastAPI](../ml-service/README.md)

Для полного модельного сценария нужны активный каталог и подключение Spring Boot к FastAPI. В подтверждённом российском контуре задайте `ML_BASE_URL=http://ml-service:8000` и `ML_DATA_REGION=RU`. Оба сервиса получают один `ML_SERVICE_TOKEN` из корневого `.env`. Для импорта каталога укажите `CATALOG_FEED_URL` либо смонтируйте файл в контейнер backend и укажите путь через `CATALOG_FEED_FILE`. [Архитектура](../ARCHITECTURE.md) · [Настройки бэкенда](../backend/README.md)

Конфигурация по умолчанию слушает loopback. Для публичного стенда задайте домен в `SITE_ADDRESS`, адрес привязки VPS в `EDGE_BIND`, порты 80 и 443 и точный HTTPS-origin в `CHAT_PUBLIC_ORIGIN`.
