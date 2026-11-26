# Готовность Frontend к интеграции — 27.11.2026

Ветка feat/frontend, исходный HEAD d9b6f11. Реализация принята пользователем
27.11.2026 и подготовлена для передачи через origin/feat/frontend. Публикация
commit/push явно разрешена; merge/deploy не входят в эту задачу. Ниже зафиксирован
состав принятой реализации и её проверки. Backend/ML/общие contracts/архитектура не менялись.

## Реализовано

- Две темы с общей геометрией, официальными логотипами, сохранением предпочтения,
  Liquid Glass и reduced motion/transparency сохранены.
- По последнему запросу фильтры менеджера заменены компактным select 210px:
  Все/Ожидают/В работе/Завершённые. Проверен на 320/390/900/1280px внутри паддингов.
- Обычный API-режим: Bearer в памяти; очередь limit/offset; polling; claim;
  назначенный GET-контекст; reply с сохранением message_id при явном повторе;
  resolve и чтение закрытой истории. Фильтр/поиск только текущей страницы.
- Реальные статусы queued/in_progress/resolved. UUID-маршруты добавлены к старым
  DEMO-маршрутам, регистр UUID нормализуется. Владение не угадывается из статуса.
- Клиент: ручной передачи нет; обычный done/restore → GET handoff, открытое обращение
  обновляется вместе с историей без блокировки ввода. sender=manager показан как
  специалист; после resolved следующее сообщение снова обрабатывает Java/ИИ.
- CaseTimeline только из доступных messages/created_at. Синтетические status/action/
  document events удалены; данных о полноценном журнале API не предоставляет.
- КП: generated QuoteRequest, customer_name 1..160 и quantity 1..99999; quantity
  относится к единице позиции, не seats. Только два JSON-поля, PDF/MIME/%PDF-,
  безопасное имя, отмена, ошибки и отсутствие автоматического POST-повтора.
- Инвойсов нет. Только mock-предпросмотр синтетической формы без HTTP/PDF/сумм/НДС.

## Входные OpenAPI

Переданные файлы побайтово сохранены в frontend/contracts; общий contracts/ пока
содержит старую версию и не переписан. api:generate/api:check используют обе новые
схемы. Происхождение/SHA: [../contracts/README.md](../contracts/README.md).
Три существующих SSE-примера скопированы без изменения для externalValue генератора.
Менеджерские DTO и QuoteRequest генерируются, поля/маршруты/events не придуманы.

## Последние проверки

| Проверка | Результат |
| --- | --- |
| pnpm api:check | Оба новых входных OpenAPI соответствуют generated types |
| TypeScript | Пройдено, включая оба Playwright config |
| ESLint | Пройдено, 0 предупреждений |
| pnpm test | 40/40, 14 файлов |
| pnpm test:e2e | 50/50, desktop/mobile Chrome |
| pnpm test:api-browser | 8/8, API-режим без MSW, контрактные HTTP-перехваты |
| Production build | Пройдено, JS ≈297 kB / gzip ≈90.7 kB, CSS 45.37 kB / gzip 8.87 kB |
| Production smoke | Компилированный API-режим, Bearer/UUID/контекст/контролы, тема, без SW/демобаннера; HTTP синтетический |
| Темы/mobile | Равная геометрия, 320px, контраст проверяемых пар ≥4.5:1, reduced motion/transparency, ввод/scroll/SSE/restore |
| git diff --check | Пройдено |
| Защищённые пути | Backend/ML/общая архитектура/contracts/lockfile/официальные assets не изменены |
| Состав Git | Только frontend/ и обязательный журнал docs/agent-work-log.md; без тестового кэша/артефактов/зависимостей |

После последнего изменения ветки маршрутизации прогнаны check и unit-нормализация
UUID. После уточнения mock-лимитов повторено скачивание КП desktop/mobile, а после
уточнения менеджерских действий повторены все 8 API-сценариев. Остальные 50 UI
сценариев прошли полным прогоном; последующие изменения не меняли их сценарии.

Промежуточные проблемы исправлены: UUID раньше открывал клиентский маршрут;
параллельные тестовые наборы конфликтовали за test-results (теперь отдельный
каталог test-results-api); ESLint не исключал trace JS; проверка credentials в
MSW заменена проверкой исходного fetch init (MSW нормализует Request).

На локальном 8080 нет запущенного Java и настоящего токена. Все API-сценарии здесь
проверены с синтетическими HTTP-ответами; реальная серверная генерация PDF,
cookie/Origin/права/конкурентные операции/каталог/ML требуют совместного прогона.
Код готов к подключению; живое соединение с Java не объявляется доказанным.

## Остаточные вопросы

- Синхронизировать общий contracts/ с переданными входными файлами владельцем схем.
- sender=manager есть в manager-схеме/описании, но не в public.Message: UI использует
  узкий адаптер, серверную схему Frontend не дописывает.
- В очереди нет assigned_to/total/global search; в истории нет events/resolved_at.
  UI не имитирует эти данные. Полный журнал и счета требуют отдельного контракта.
- Выдача/ротация Bearer, реальный CHAT_PUBLIC_ORIGIN/cookie/HTTPS и совместная
  проверка чужих/закрытых обращений остаются шагом интеграции.

Подробно: [backend-integration.md](backend-integration.md),
[backend-questions.md](backend-questions.md).

## Локальный просмотр

Из frontend/: pnpm dev:mock → http://127.0.0.1:5173/ (синтетический UI).
Для реального Java: pnpm dev; при необходимости BACKEND_PROXY_TARGET.
Manager /#/manager предложит токен, client /#/chat использует сессионную cookie.
Адрес Frontend нужно разрешить на Java в CHAT_PUBLIC_ORIGIN.

```sh
export PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:$PATH"
pnpm dev:mock
```

## Скриншоты

.cache/visual-preview/integration-final/ (ignored):
manager-queue/manager-case/client/quote × dark/light × desktop/mobile = 16 PNG.
Это явно обозначенный mock UI с синтетическими данными, без настоящих документов.
screenshots.json фиксирует отсутствие runtime-ошибок/горизонтального переполнения.
production-smoke.json — отдельная проверка собранного API-режима на HTTP-перехватах.
API-скриншоты после resolve также сохраняет test:api-browser в test-results-api.

## Состав публикации относительно d9b6f11

Включает принятые темы/UX и интеграцию. Manifest подготовки commit: M изменён,
D удалена ручная передача, A/?? новый файл. Пути от корня репозитория:

```text
MM docs/agent-work-log.md
M  frontend/.gitignore
M  frontend/README.md
AM frontend/contracts/README.md
A  frontend/contracts/examples/public-clarify.sse
A  frontend/contracts/examples/public-failed.sse
A  frontend/contracts/examples/public-recommend.sse
A  frontend/contracts/manager.openapi.yaml
A  frontend/contracts/public.openapi.yaml
M  frontend/docs/backend-integration.md
M  frontend/docs/backend-questions.md
M  frontend/docs/brandbook-review.md
M  frontend/docs/design-system.md
M  frontend/docs/release-readiness.md
M  frontend/docs/requirements-audit.md
M  frontend/eslint.config.js
M  frontend/index.html
M  frontend/package.json
A  frontend/playwright.api.config.ts
M  frontend/scripts/check-contract.mjs
A  frontend/scripts/generate-contracts.mjs
M  frontend/src/app/App.tsx
M  frontend/src/app/styles/global.css
M  frontend/src/app/styles/theme-dark.css
M  frontend/src/app/styles/tokens.css
M  frontend/src/app/styles/workspace.css
A  frontend/src/entities/handoff/CaseTimeline.test.tsx
A  frontend/src/entities/handoff/CaseTimeline.tsx
M  frontend/src/entities/handoff/types.ts
M  frontend/src/features/chat/model/ChatController.ts
A  frontend/src/features/chat/ui/AutomaticHandoffNotice.test.tsx
A  frontend/src/features/chat/ui/AutomaticHandoffNotice.tsx
M  frontend/src/features/chat/ui/MessageComposer.tsx
D  frontend/src/features/handoff/ChatHandoff.tsx
D  frontend/src/features/handoff/demoStore.test.ts
D  frontend/src/features/handoff/demoStore.ts
M  frontend/src/features/handoff/fixtures.ts
A  frontend/src/features/handoff/useSessionHandoff.ts
A  frontend/src/features/quote/InvoiceDemo.test.tsx
A  frontend/src/features/quote/InvoiceDemo.tsx
M  frontend/src/features/quote/QuoteDraftAction.tsx
M  frontend/src/features/quote/quoteApi.test.ts
M  frontend/src/features/quote/quoteApi.ts
M  frontend/src/mocks/handlers.ts
M  frontend/src/pages/chat/ChatPage.tsx
A  frontend/src/pages/manager/ManagerConnected.tsx
M  frontend/src/pages/manager/ManagerPage.test.tsx
M  frontend/src/pages/manager/ManagerPage.tsx
A  frontend/src/pages/manager/ManagerWorkspace.tsx
M  frontend/src/shared/api/guards.ts
A  frontend/src/shared/api/handoffApi.test.ts
A  frontend/src/shared/api/handoffApi.ts
A  frontend/src/shared/api/manager-schema.d.ts
M  frontend/src/shared/api/schema.d.ts
M  frontend/src/shared/api/types.ts
A  frontend/src/shared/lib/theme.test.tsx
A  frontend/src/shared/lib/theme.ts
A  frontend/src/shared/lib/useAppRoute.test.ts
M  frontend/src/shared/lib/useAppRoute.ts
M  frontend/src/shared/ui/Icon.tsx
M  frontend/src/shared/ui/WorkspaceHeader.tsx
A  frontend/tests/api-browser/integration.spec.ts
M  frontend/tests/e2e/manager.spec.ts
A  frontend/tests/e2e/themes.spec.ts
M  frontend/tsconfig.json
?? frontend/.gitattributes
```
