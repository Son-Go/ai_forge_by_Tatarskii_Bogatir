# Локальный запуск

Из корня скопируйте `infra/.env.example` в `infra/.env`, задайте пароль PostgreSQL и запустите Compose.

```sh
docker compose --env-file infra/.env -f infra/compose.yaml up --build
curl --fail http://localhost:8080/health/ready
```

Flyway применяет начальную схему при старте Java. Caddy проксирует API и health и раздаёт сборку из `frontend/dist/`, когда команда фронтенда её подготовит.

Конфигурация по умолчанию слушает loopback. Для публичного стенда задайте домен в `SITE_ADDRESS`, адрес привязки VPS в `EDGE_BIND` и порты 80 и 443. Добавление сервиса FastAPI в сеть Compose, настройка импорта и проверка провайдера модели входят в план интеграции.
