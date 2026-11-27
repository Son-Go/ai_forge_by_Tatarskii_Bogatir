# Входные контракты Backend — 28.11.2026

`public.openapi.yaml` и `manager.openapi.yaml` синхронизированы с файлами из `../contracts`.
Публичная схема включает назначение и номер тестового счёта из Java API.

SHA-256:
- public: 4965ba8f8a62f1b7b2409d6b9f7de94e95c798fa50fc15fe85b23699019fb225
- manager: a5e579ba5c1bed0afd42ae93ba2ab63ba7765a9a65adea0088ffbaeac82245ec

examples/ — три существующих публичных SSE-примера из общей contracts/examples,
скопированные без изменения для разрешения externalValue при генерации типов.
Завершающая пустая строка обязательна для SSE-события. frontend/.gitattributes
исключает только blank-at-eof для этих примеров; прочие whitespace-проверки сохранены.

pnpm api:generate генерирует schema.d.ts и manager-schema.d.ts; pnpm api:check
сверяет оба набора. При получении новых файлов обновление входных схем согласуется
с командой, затем повторяются генерация, runtime guards и интеграционные тесты.
Общая папка contracts должна быть консолидирована владельцем серверных контрактов;
генератор Frontend не переписывает её и не утверждает актуальность старого общего YAML.
