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
