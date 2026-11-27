ALTER TABLE chat_sessions ADD COLUMN support_topic text
    CHECK (support_topic IN ('key_delivery', 'key_activation', 'refund'));

ALTER TABLE chat_handoffs DROP CONSTRAINT chat_handoffs_reason_check;
ALTER TABLE chat_handoffs ADD CONSTRAINT chat_handoffs_reason_check CHECK (
    reason IN ('document_review', 'off_catalog_order', 'instruction_failed', 'payment_deferral')
);
ALTER TABLE chat_handoffs ADD COLUMN sales_context jsonb;

WITH guides(source_url, title, topic, body) AS (VALUES
    ('https://store.softline.ru/delivery_info/', 'Электронная доставка Softline Store', 'key_delivery',
     'Электронная лицензия приходит на адрес, указанный в заказе. Проверьте этот почтовый ящик, включая папку «Спам», и сверяйте срок отправки с карточкой товара. Если письмо не найдено, сообщите, что инструкция не помогла.'),
    ('https://store.softline.ru/contacts/', 'Техническая поддержка Softline Store', 'key_activation',
     'Сверьте название и редакцию программы с заказом. Выполните шаги активации из письма или инструкции производителя. Если активация по-прежнему не проходит, сообщите название программы и текст ошибки. Сам ключ в чат не отправляйте.'),
    ('https://store.softline.ru/delivery_info/#q15', 'Порядок возврата Softline Store', 'refund',
     'Откройте раздел об условиях возврата для своего типа покупки. Для рассмотрения подготовьте номер заказа или счёта, название позиции и причину возврата. Если по инструкции не удалось решить вопрос, сообщите об этом в чате.')
), inserted AS (
    INSERT INTO knowledge_documents (document_id, source_url, title, fetched_at, content_hash, version)
    SELECT gen_random_uuid(), source_url, title, '2026-11-27T00:00:00+03:00', md5(body), 'support-hackathon-2026-11-27'
    FROM guides RETURNING document_id, source_url
)
INSERT INTO knowledge_chunks (chunk_id, document_id, section, body)
SELECT gen_random_uuid(), inserted.document_id, 'after_sale:' || guides.topic, guides.body
FROM inserted JOIN guides USING (source_url);

ALTER TABLE chat_sessions ADD COLUMN price_objection boolean NOT NULL DEFAULT false,
    ADD COLUMN coupon_state text CHECK (coupon_state IN ('present', 'absent')),
    ADD COLUMN discount_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 5);
ALTER TABLE quote_drafts ADD COLUMN discount_percent numeric(5,2) NOT NULL DEFAULT 0
    CHECK (discount_percent BETWEEN 0 AND 5),
    ADD COLUMN agreed_total numeric CHECK (agreed_total >= 0);
