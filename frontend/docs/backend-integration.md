# Интеграция Frontend с Backend — 27.11.2026

Frontend реализует оба переданных OpenAPI. Неизменённые входные копии находятся
в frontend/contracts; исходные общий contracts/, Backend, ML и архитектура не менялись.
Схемы/происхождение: [../contracts/README.md](../contracts/README.md).
Типы public и manager генерируются существующим openapi-typescript, без новых зависимостей.

## Что подключено в API-режиме

| Операция | Запрос/ответ | Реализация |
| --- | --- | --- |
| Сессия/диалог | POST/GET sessions, POST messages → accepted/status/delta/done/failed | Существующий fetch/SSE, идемпотентность и recovery сохранены; text до 4000 |
| Выбор | POST sessions/{id}/selection | offer_id/catalog_version, OFFER_CHANGED и подтверждение |
| КП | POST sessions/{id}/quote-drafts → PDF | JSON QuoteRequest: customer_name 1..160, quantity 1..99999; MIME/%PDF-, отмена/ошибки/скачивание |
| Клиентский статус | GET sessions/{id}/handoff → {handoff:null|Handoff} | После done/restore; пока queued/in_progress — polling статуса и истории; resolved возвращает к ИИ |
| Очередь | GET manager/handoffs?limit=50&offset=N → QueueItem[] | Bearer, offset pagination, polling 5с, локальный поиск/фильтр только текущей страницы |
| Назначение | POST manager/handoffs/{id}/claim → QueueItem | Явное взятие queued; состояние только из ответа сервера |
| Контекст | GET manager/handoffs/{id} → {handoff,messages} | Доступ назначенного обращения; 404 не трактуется как доказанное владение |
| Ответ | POST manager/handoffs/{id}/messages → ChatMessage | UUID message_id + text 1..4000, явный повтор того же текста с тем же ID, без автоповтора POST |
| Завершение | POST manager/handoffs/{id}/resolve → QueueItem | Явное закрытие своего активного обращения; resolved остаётся читаемым |
| Health | /health/live, /health/ready | Проксируются Vite, не опрашиваются ради имитации готовности ML |

Manager API использует Authorization: Bearer, credentials=omit; сессионный API —
same-origin cookie HttpOnly/Secure/SameSite=Lax. Токен вводится вручную, только в памяти
App, очищается при выходе/401/reload. Отдельного login/refresh-token endpoint в схемах нет.
Секреты не используются в VITE_*, URL или хранилищах браузера.

## Очередь и история

queued/in_progress/resolved отображаются как «Ожидает решения»/«В работе»/«Завершено».
Компактный select 210px — «Все», «Ожидают», «В работе», «Завершённые».
У API нет общего total и глобального фильтра/поиска. UI подписывает область текущей
страницы; при 50 элементах позволяет следующую, при <50 отключает Далее. Пустая
страница после ровно полного последнего блока допустима, Назад остаётся доступна.
Polling последовательный, без накладывающихся запросов, отменяется при уходе/смене
страницы/обращения. Скрытая вкладка откладывает опрос. Сетевой сбой не выдаёт старую
страницу за свежую: ошибка видна. 401 очищает менеджерский доступ.

QueueItem не содержит имени/владельца/requirements. Заголовок строится из reason,
владение не угадывается из in_progress: нужны успешные назначенные GET-детали.
Карточки и источники берутся только из доступных messages. Структурированные
требования не извлекаются на Frontend. Журнала events нет: CaseTimeline показывает
только сообщения и их created_at, без вымышленных действий, документов или времён.
Для resolved сервер обещает переписку до закрытия; UI не достраивает поздние сообщения.

## Клиентская автоэскалация

Решение принимает Java. Нового SSE event нет: обычный done, затем чтение handoff.
UI проверяет handoff после завершённого/восстановленного хода, не анализируя слова
модели и не принимая решение по цене/insufficient_data. Ручной кнопки нет.

Открытый handoff опрашивается вместе с GET сессии. Реплики role=assistant,sender=manager
подписываются «Специалист Softline» без AI-бейджа. Background refresh не переводит
редактор в loading: ввод/черновик остаются доступны; active send/selection защищены
epoch/AbortSignal и не перезаписываются фоновым GET. При resolved выполняется последняя
сверка истории, polling прекращается. Следующее сообщение идёт в обычный POST messages,
а его обработчика снова определяет Java. Reload читает и историю, и последний handoff.

## Документы

quantity — число единиц выбранной каталожной позиции, не seats: лицензия на 50
пользователей может быть одной позицией quantity=1. Только customer_name и quantity.
Ни ИНН/КПП, ни ставка НДС, ни расчёт цены/итога в запрос не добавлены. PDF формирует
Backend. Клиент проверяет тип/сигнатуру, фиксирует имя файла, показывает ошибки
400/403/404/409/429/503; OFFER_CHANGED требует обновления/подтверждения, не автоповтора.

Java выдаёт PDF-черновик счёта через `POST /api/v1/sessions/{session_id}/invoice-drafts`
при `CHAT_INVOICE_DRAFTS_ENABLED=true`. Тело запроса содержит `customer_name`
и `quantity`. Сервер повторно сверяет цену выбранной позиции. Интерфейс
счёта пока доступен в mock-режиме как локальный предпросмотр.
Для счёта на оплату осталось согласовать его связь с заказом, реквизиты сторон,
источник налоговых данных и правила выпуска документа.

## Что проверено, а что нет

pnpm check: два API, TS, ESLint, 40 unit/14 файлов, production build.
pnpm test:e2e: 50 сценариев mock UI, desktop/mobile, две темы, 320px,
геометрия/контраст/reduced motion/transparency, SSE/retry/restore/composer/scroll.
pnpm test:api-browser: 8 сценариев обычного API-режима с перехватами HTTP в Chrome,
включая claim → reply/retry того же ID → resolve/закрытая история, pagination/polling/401,
невалидный ответ, client handoff → ответ менеджера → resolved → ИИ, PDF/ошибка.
Это сетевые контрактные моки, НЕ запущенный Spring Boot. В окружении нет Java на 8080
и настоящего токена; реальный PDF/Origin/cookie/права/ML пока не прошли совместную приёмку.

## Совместный запуск

В frontend/: pnpm dev:mock — демонстрация; pnpm dev — реальный same-origin API через
Vite /api и /health → http://127.0.0.1:8080. Другой target: BACKEND_PROXY_TARGET.
Backend может добавить http://127.0.0.1:5173 в CHAT_PUBLIC_ORIGIN через запятую.
Frontend не менял конфигурацию Java. Стенд — HTTPS/Caddy без буферизации SSE.

Нужен совместный прогон с Java/БД/каталогом/ML и выданным менеджерским токеном:
сессия/подбор/выбор/reload, ошибки/повторы/обрывы, PDF с quantity=1 на 50 seats,
все менеджерские операции/права/401/404/409, client open handoff/уточнения/reply/resolve.
Полная UI-реализация готова к этому прогону; успешная интеграция с живым сервером
не объявляется по результатам моков.
