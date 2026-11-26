# Готовность Frontend к публикации исходников

Актуальная проверка: 26 ноября 2026, ветка **feat/frontend**, исходный HEAD
`8359e42bfe7499d4a20a125875d1dae4c48f0715`. Рабочая ветка уже отслеживает
`origin/feat/frontend`; по локальным remote refs HEAD совпадает. Сетевой fetch не выполнялся.
Remote: https://github.com/Son-Go/ai_forge_by_Tatarskii_Bogatir.git.

**Исходники готовы к ручному commit/push для интеграции.** Блокирующих проблем
по выполненным проверкам нет. Это не заявление о завершённой интеграции настоящего
Backend/ML или готовности менеджерской очереди к работе с реальными обращениями.
Git add/commit/push/merge/deploy не выполнялись; индекс пуст.

## Последняя UX-доработка

- Круглая кнопка вниз 40 px desktop / 44 px mobile, без видимого текста, с aria-label
  и title «К последнему сообщению». Glass, фокус и reduced motion сохранены.
  Отдельный ряд между историей и composer исключает наложение на сообщения.
  IntersectionObserver следит за концом при стриминге, resize и смене раздела;
  исходная политика auto-follow не изменена.
- Пузырь пользователя справа, ИИ слева; короткий текст занимает свою ширину,
  длинный ограничен 72ch/доступной шириной. Карточки и источники не сужены:
  до/после 440/720 px на desktop, 332/332 px на mobile.
- Доступная метка «Ваше сообщение» сохранена через sr-only; видимый заголовок убран.
  Placeholder «Напишите сообщение...». Форма 70 px в пустом состоянии,
  textarea 28–160 px, ряд/текст/отправка центрированы по всему полю; клик по
  свободной области фокусирует ввод. Обработчики отправки и автогроу сохранены.
- Предыдущие Dark Premium, оригинальный русский SVG-логотип, шрифтовая иерархия,
  графитовые карточки и два различимых статуса, анимации и оба раздела сохранены.

## Проверки

| Проверка | Результат |
| --- | --- |
| API-типы | pnpm api:check: совпадают с публичным OpenAPI |
| TypeScript | pnpm typecheck: прошёл |
| ESLint | pnpm lint: без предупреждений |
| Vitest | 31 тест в 9 файлах прошёл |
| Playwright | 36/36 Chrome desktop/mobile |
| Production | pnpm build прошёл, sourcemap/worker/MSW-обработчиков в артефактах нет |
| API-mode smoke | Production без MSW с перехваченным контрактным API: сессия, POST/SSE, GET/reload, выбор, PDF прошли |
| Cookie/Origin smoke | Тестовая HttpOnly-cookie передаётся и не читается JS; POST содержит Origin; это не проверка Secure/Origin-политики реального Backend |
| Менеджер в production | Не вызывает публичный API/не подставляет demo-очередь; явно показано отсутствие подключения |
| UX | Короткие/длинные/неразрывные строки, textarea/фокус, круглая кнопка вне текста, переход к концу/resize, активный SSE/черновик/история |
| Адаптивность/доступность | 1280/390/320 px, нет горизонтального переполнения; контраст проверенных сочетаний ≥4.5:1, reduced motion/transparency |
| Runtime | Неожиданных pageerror/ResizeObserver-ошибок в проверенных сценариях нет |
| Git | diff --check прошёл, индекс пуст; Backend/ML/архитектура/контракты/зависимости без изменений |

Production: JS 284.78 kB / gzip 87.36 kB; CSS 41.71 kB / gzip 8.08 kB;
активный SVG 12.64 kB / gzip 3.13 kB. Файлы шрифтов и новые зависимости не добавлялись.

Итоговые 10 локальных скриншотов находятся в `.cache/visual-preview/pre-publication/`
(клиент, прокрутка, менеджер, мобильные и 320 px); осмотрены целиком. В Git не входят.

## Что готово, а что демонстрационное

| Категория | Функции и граница |
| --- | --- |
| Готово к реальному API | Создание/восстановление сессий, POST/fetch SSE, история, повторы/ошибки, карточки/источники/выбор, OFFER_CHANGED, опциональный PDF при quotes_enabled |
| Только dev:mock | Синтетические ответы каталога/знаний, демоочередь менеджера и DEMO-передача с локальным снимком; статический маркированный PDF без коммерческой силы |
| Не подключено | Реальная регистрация/очередь/статусы обращений, менеджерская авторизация, структурированные требования из сервера, счёт/оплата/CRM/загрузка файлов |
| Нужно Backend | Сессионные/диалоговые маршруты, cookie/Origin/идемпотентность/лимиты и БД, каталог/знания/ML, согласованные контракты менеджера и документов |

Точная инструкция и совместный приёмочный прогон: [backend-integration.md](backend-integration.md).
Открытые вопросы: [backend-questions.md](backend-questions.md). Реальные Spring Boot/ML
не запускались; Secure-cookie, HTTPS, proxy/SSE-буферизация и настоящие данные требуют
совместного прогона. Интерфейс не выдаёт локальную регистрацию за реальную передачу.

## Состав публикации и статический аудит

Всего **42 файлов** в рабочем дереве: **17 изменённых**, **25 новых**.
Это кандидаты для будущего коммита, не содержимое индекса.
Проверены все 74 исходных файлов области frontend/ + журнала:
72 текстовых и 2 официальных PNG. Кандидатов на секреты, маркеров конфликтов,
лишних пробелов, tracked ignored-файлов и запрещённых артефактов не найдено.

- В составе только Frontend и обязательный docs/agent-work-log.md. API/SSE,
  reducer/controller/storage сессии, Backend/ML, contracts, infra, AGENTS.md,
  общая архитектура, package.json и pnpm-lock.yaml не изменены.
- node_modules, dist, test-results, .cache, .pnpm-store и локальные env исключены
  из Git. Скриншоты, PDF брендбука, ZIP, каталог заказчика, runtime-файлы и
  кэш в коммит не входят. Удалённых исходников нет.
- public/mockServiceWorker.js — необходимый исходный worker разработки, не кэш;
  production publicDir выключен. Синтетические fixtures менеджерского UI могут
  быть в JS-бандле, но не являются MSW и не подставляются в production-очередь.
- В assets оставлены активный официальный русский SVG и три ранее сохранённых
  официальных варианта как материалы дизайн-системы. В dist попадает только
  активный SVG. Эти небольшие исходные активы не являются временными файлами.
- Статический поиск выполнен без вывода возможных значений секретов; найденных
  кандидатов нет. GitHub-авторизация и состояние сервера GitHub не проверялись
  попытками отправки; push выполняет пользователь.

Изменённые tracked-файлы:

```text
docs/agent-work-log.md
frontend/README.md
frontend/docs/backend-questions.md
frontend/docs/design-system.md
frontend/docs/release-readiness.md
frontend/src/app/App.tsx
frontend/src/app/main.tsx
frontend/src/app/styles/global.css
frontend/src/app/styles/tokens.css
frontend/src/entities/offer/OfferCard.tsx
frontend/src/features/chat/ui/MessageComposer.tsx
frontend/src/mocks/handlers.ts
frontend/src/pages/chat/ChatPage.test.tsx
frontend/src/pages/chat/ChatPage.tsx
frontend/src/shared/ui/Icon.tsx
frontend/tests/e2e/appearance.spec.ts
frontend/tests/e2e/chat.spec.ts
```

Новые файлы:

```text
frontend/docs/backend-integration.md
frontend/docs/brandbook-review.md
frontend/docs/requirements-audit.md
frontend/src/app/styles/theme-dark.css
frontend/src/app/styles/workspace.css
frontend/src/entities/handoff/types.ts
frontend/src/features/handoff/ChatHandoff.tsx
frontend/src/features/handoff/demoStore.test.ts
frontend/src/features/handoff/demoStore.ts
frontend/src/features/handoff/fixtures.ts
frontend/src/features/quote/QuoteDraftAction.tsx
frontend/src/features/quote/quoteApi.test.ts
frontend/src/features/quote/quoteApi.ts
frontend/src/mocks/quoteDraftPdf.ts
frontend/src/pages/manager/ManagerPage.test.tsx
frontend/src/pages/manager/ManagerPage.tsx
frontend/src/shared/assets/softline/softline-sofl-white.svg
frontend/src/shared/assets/softline/softline-solutions-sofl-white.png
frontend/src/shared/assets/softline/softline-solutions-sofl-white.svg
frontend/src/shared/assets/softline/softline-solutions-sofl.png
frontend/src/shared/lib/useAppRoute.ts
frontend/src/shared/ui/WorkspaceHeader.tsx
frontend/tests/e2e/manager.spec.ts
frontend/tests/e2e/motion.spec.ts
frontend/tests/e2e/ux.spec.ts
```

## Ручные команды пользователя

Из корня репозитория (команды здесь приведены для ручного выполнения; агент их не исполнял):

```sh
git branch --show-current
git status --short
git diff --check
git add -- frontend docs/agent-work-log.md
git diff --cached --stat
git diff --cached --check
git commit -m "feat(frontend): add Dark Premium workspaces and polished chat UX"
git push origin feat/frontend
```

Для локального просмотра: из frontend/ `pnpm dev:mock`, http://127.0.0.1:5173.
Команды PATH для runtime Codex и запуск реального API-режима есть в README.md.
Публикация исходников не запускает деплой.

<details>
<summary>Историческая проверка перед коммитом 8359e42 (не актуальный состав файлов)</summary>

# Готовность Frontend к фиксации и публикации

Проверка: 26 ноября 2026 года. Рабочая ветка: `feat/frontend`.

Исходники Frontend готовы к ручной фиксации и отправке на GitHub. Блокирующих проблем
по выполненным проверкам не осталось. Рабочее дерево ещё не закоммичено: ничего не
добавлено в индекс, upstream у локальной ветки отсутствует. Git add/commit/push/merge,
публикация и деплой в рамках работы не выполнялись.

Это готовность к публикации исходников самостоятельного Frontend. Готовность продукта
с реальными Backend/ML требует совместной интеграционной проверки.

## Что исправлено в финальной доработке

- Заголовок «Ваше сообщение» сохранён над общим рядом textarea и кнопки.
- Однострочный текст и placeholder центрированы в доступной области; отправка справа
  выровнена по центру ряда. Кнопка сохраняет размер 48×48 px и доступное название.
- Свободная область формы фокусирует textarea; нажатие самой кнопки не перехватывается.
- Пустой composer ниже 110 px на проверенных ширинах; textarea растёт от 28 до 160 px,
  затем прокручивается внутри, сжимается после очистки и пересчитывается при смене ширины.
- Радиусы 10/16/24/32 px, существующая палитра и общая композиция сохранены.
- API, SSE, контроллер, reducer, хранение сессии и моки не изменялись при полировке.

## Проверки

| Проверка | Итог |
| --- | --- |
| Актуальность типов OpenAPI | api:check прошёл |
| TypeScript | typecheck прошёл |
| ESLint | прошёл без предупреждений |
| Vitest | 26 тестов в 6 файлах прошли |
| Playwright | все 14 браузерных сценариев прошли |
| Production | build прошёл; моки отсутствуют в production JS и public-артефактах |
| Адаптивность | 1280, 390 и 320 px; нет горизонтального переполнения |
| Ввод | фокус по свободной области, центрирование, длинный текст, очистка, размер кнопки |
| Поведение | отправка/блокировка, клавиатура, ошибка, повтор, обрыв, история и выбор карточки |
| Консоль браузера | в проверенных сценариях нет ошибок приложения/ResizeObserver |
| Скриншоты | десктоп и узкий мобильный экран осмотрены |
| git diff --check | прошёл; отдельно проверены пробелы и маркеры конфликтов новых файлов |

В промежуточной проверке исправлен неподдерживаемый параметр exact в новом запросе
React Testing Library. Финальный полный прогон успешно выполнен после исправления.

## Проверка состава и безопасности

- Изменения относительно HEAD ограничены frontend/ и журналом docs/agent-work-log.md.
- git diff для Backend, ML, общей архитектуры, AGENTS.md, contracts/ и infra/ пуст.
- Контрольные суммы 45 защищённых файлов совпали с исходными перед визуальными правками,
  включая API/SSE, управление состоянием, моки, package.json и lockfile.
- Выполнен статический поиск приватных ключей, GitHub/API/cloud/npm-токенов и присваиваний
  секретов в tracked и новых исходниках. Подтверждённых секретов не обнаружено.
- Единственное совпадение поиска URL с паролем — намеренная тестовая строка
  user:password@example.com в presentation.test.ts, проверяющая отклонение таких ссылок.
- node_modules/, dist/, test-results/, .cache/, .pnpm-store/ и .env.local исключены из Git.
  Локальные артефакты проверок остаются на диске, в список публикации не входят.
- Уже отслеживаемых Git файлов, совпавших с правилами исключения, не найдено.
- public/mockServiceWorker.js — необходимый исходный worker режима разработки,
  а не временный кэш; в production-сборку он не копируется.
- Скриншотов, архивов, каталога заказчика, локальных env и бинарного мусора среди
  кандидатов публикации нет. Зависимости не добавлялись.

Статический поиск не заменяет серверную проверку доступа и будущую проверку интеграции.

## Полный список кандидатов для будущего коммита

Всего **49 файлов**: **2 изменённых** и **47 новых**. Это список рабочего дерева, не индекс Git.

Изменённые отслеживаемые файлы:

```text
docs/agent-work-log.md
frontend/README.md
```

Новые файлы:

```text
frontend/.gitignore
frontend/.node-version
frontend/docs/backend-questions.md
frontend/docs/design-system.md
frontend/docs/release-readiness.md
frontend/eslint.config.js
frontend/index.html
frontend/package.json
frontend/playwright.config.ts
frontend/pnpm-lock.yaml
frontend/public/mockServiceWorker.js
frontend/scripts/check-contract.mjs
frontend/src/app/App.tsx
frontend/src/app/main.tsx
frontend/src/app/styles/global.css
frontend/src/app/styles/tokens.css
frontend/src/entities/offer/OfferCard.tsx
frontend/src/entities/source/SourcesList.tsx
frontend/src/features/chat/lib/sessionStorage.ts
frontend/src/features/chat/model/ChatController.test.ts
frontend/src/features/chat/model/ChatController.ts
frontend/src/features/chat/model/chatReducer.ts
frontend/src/features/chat/model/useChat.ts
frontend/src/features/chat/ui/MessageComposer.test.tsx
frontend/src/features/chat/ui/MessageComposer.tsx
frontend/src/features/chat/ui/TurnStatus.tsx
frontend/src/mocks/browser.ts
frontend/src/mocks/handlers.ts
frontend/src/pages/chat/ChatPage.test.tsx
frontend/src/pages/chat/ChatPage.tsx
frontend/src/shared/api/chatApi.ts
frontend/src/shared/api/client.ts
frontend/src/shared/api/guards.test.ts
frontend/src/shared/api/guards.ts
frontend/src/shared/api/schema.d.ts
frontend/src/shared/api/sse.test.ts
frontend/src/shared/api/sse.ts
frontend/src/shared/api/types.ts
frontend/src/shared/lib/presentation.test.ts
frontend/src/shared/lib/presentation.ts
frontend/src/shared/ui/Icon.tsx
frontend/src/test/setup.ts
frontend/tests/e2e/appearance.spec.ts
frontend/tests/e2e/chat.spec.ts
frontend/tsconfig.json
frontend/vite.config.ts
frontend/vitest.config.ts
```

## Перед интеграцией с Backend

1. Подключить рабочие маршруты сессии, сообщений/SSE и выбора на одном origin.
2. Проверить HttpOnly/Secure/SameSite cookie и допустимый Origin в разработке и HTTPS-стенде.
3. Согласовать гарантии seq, воспроизведение завершённого запроса и связь восстановленного
   failed с исходным вопросом; проверить идемпотентность, 409/429 и таймауты на реальном API.
4. Подтвердить поля attributes, семантику нулевой цены, источники и смену версии предложения.
5. Пройти три основных сценария с настоящими каталогом/знаниями/ML, холодный запрос,
   обрыв, перезагрузку, историю и повтор на общем HTTPS-стенде.

Подробности находятся в backend-questions.md. Эти вопросы не блокируют публикацию
Frontend-исходников и независимую разработку на контрактных моках.


</details>
