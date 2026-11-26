# Локальный запуск

При первом локальном запуске скопируйте `infra/.env.example` в `.env` в корне репозитория и задайте пароль PostgreSQL. Затем выполните из корня проекта.

```sh
docker compose up -d --build
docker compose ps
curl --fail http://localhost:8080/health/live
```

Корневой Compose собирает цели `backend`, `ml-service` и `caddy` из общего [Dockerfile](../Dockerfile) и запускает PostgreSQL из образа `postgres:17`. Образ Caddy собирает фронтенд из зафиксированных зависимостей и раздаёт его по адресу `http://localhost:8080`. Flyway применяет схему при старте Java. `/health/ready` показывает `200` после появления активного снимка каталога.

Для модельных ответов нужны активный каталог и настроенный профиль FastAPI. Задайте внутренний адрес `ML_BASE_URL=http://ml-service:8000` и общий `ML_SERVICE_TOKEN`. Переменная `ML_DATA_REGION=RU` подтверждает размещение всего контура обработки реальных сообщений в РФ. [Настройки бэкенда](../backend/README.md) · [Настройки FastAPI](../ml-service/README.md)

Конфигурация по умолчанию слушает loopback. Для публичного стенда задайте домен в `SITE_ADDRESS`, адрес привязки VPS в `EDGE_BIND`, порты 80 и 443 и точный HTTPS-origin в `CHAT_PUBLIC_ORIGIN`.
