WITH guides(source_url, title, section, body) AS (VALUES
    ('https://store.softline.ru/b2b/', 'Способы оплаты Softline Store', 'commercial:payment',
     'Для онлайн-заказов Softline Store указывает оплату банковской картой или переводом. Доступные способы для конкретного заказа можно проверить при оформлении.'),
    ('https://store.softline.ru/about/', 'Консультация по заказу Softline Store', 'commercial:off_catalog',
     'Если нужной позиции нет в каталоге, возможность заказа можно уточнить у менеджера Softline Store. Для проверки полезны название продукта, редакция и артикул, если он известен.')
), inserted AS (
    INSERT INTO knowledge_documents (document_id, source_url, title, fetched_at, content_hash, version)
    SELECT gen_random_uuid(), source_url, title, '2026-11-28T00:00:00+03:00', md5(body), 'commercial-guides-2026-11-28'
    FROM guides RETURNING document_id, source_url
)
INSERT INTO knowledge_chunks (chunk_id, document_id, section, body)
SELECT gen_random_uuid(), inserted.document_id, guides.section, guides.body
FROM inserted JOIN guides USING (source_url);
