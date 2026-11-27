export interface paths {
    "/api/v1/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Открыть сессию
         * @description Изменяющие запросы проверяются по заголовку Origin.
         */
        post: operations["createSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sessions/{session_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        /** Прочитать состояние сессии и историю */
        get: operations["getSession"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sessions/{session_id}/messages": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Принять сообщение и выдать SSE
         * @description Повтор с прежним идентификатором и тем же телом возвращает сохранённый результат. Если ход ещё идёт, возвращается 409 TURN_IN_PROGRESS с turn_id. При повторном использовании идентификатора с другим телом возвращается 409 IDEMPOTENCY_CONFLICT. Для повтора завершившегося ошибкой хода используется новый client_message_id, исходный text и retry_of_turn_id.
         */
        post: operations["submitMessage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sessions/{session_id}/selection": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Выбрать ранее показанное предложение
         * @description При существенном изменении возвращается 409 OFFER_CHANGED и актуальная карточка, когда она доступна. Её можно подтвердить повторным запросом с новой версией каталога в той же сессии.
         */
        post: operations["selectOffer"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sessions/{session_id}/quote-drafts": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Сформировать КП по сохранённому выбору
         * @description Доступность возвращает quotes_enabled. Нужен подтверждённый выбор в сессии. Сервер сохраняет условия и создаёт новую версию КП. При изменении предложения подтвердите новую карточку через selection. Количество относится к единице выбранной позиции.
         */
        post: operations["createQuoteDraft"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sessions/{session_id}/quote-drafts/{quote_id}/approval": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: components["parameters"]["SessionId"];
                quote_id: components["schemas"]["Uuid"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Подтвердить условия конкретной версии КП
         * @description Одобрение идемпотентно. QUOTE_SUPERSEDED означает, что нужно сформировать новую версию. При OFFER_CHANGED подтвердите актуальную карточку, сформируйте новое КП и одобрите его.
         */
        post: operations["approveQuoteDraft"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sessions/{session_id}/invoice-drafts": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Получить PDF счёта по одобренному КП
         * @description Доступен при CHAT_INVOICE_DRAFTS_ENABLED=true. Первая выдача требует явного одобрения актуального КП. Позиция, количество, цена и валюта берутся из снимка КП. QUOTE_APPROVAL_REQUIRED означает, что КП нужно одобрить. При изменении условий требуется новое КП и его одобрение. Повтор для того же quote_id возвращает ранее выданный PDF. Документ предназначен для согласования и содержит справочные реквизиты поставщика.
         */
        post: operations["createInvoiceDraft"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/health/live": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["liveness"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/health/ready": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Возвращает 200 при доступном активном снимке PostgreSQL и 503 при отсутствии снимка или недоступной БД. */
        get: operations["readiness"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /** Format: uuid */
        Uuid: string;
        QuoteRequest: components["schemas"]["DocumentDraftRequest"];
        InvoiceDraftRequest: {
            quote_id: components["schemas"]["Uuid"];
        };
        DocumentDraftRequest: {
            customer_name: string;
            quantity: number;
        };
        Session: {
            session_id: components["schemas"]["Uuid"];
            messages: (components["schemas"]["Message"] & unknown)[];
            selected_offer: components["schemas"]["OfferCard"] | null;
            last_turn: components["schemas"]["Turn"] | null;
            quotes_enabled: boolean;
            price_terms?: components["schemas"]["PriceTerms"];
            /**
             * @description Тема выданной инструкции, по которой можно сообщить, что она не помогла.
             * @enum {unknown}
             */
            support_topic?: "key_delivery" | "key_activation" | "refund";
        };
        Turn: {
            turn_id: components["schemas"]["Uuid"];
            /** @enum {unknown} */
            status: "running" | "complete" | "failed";
            outcome?: components["schemas"]["Outcome"];
            error_code?: string;
        };
        Message: {
            id: components["schemas"]["Uuid"];
            /** @enum {unknown} */
            role: "user" | "assistant";
            text: string;
            /** @enum {unknown} */
            status?: "streaming" | "complete" | "partial";
            cards: components["schemas"]["OfferCard"][];
            sources: components["schemas"]["Source"][];
            /** Format: date-time */
            created_at: string;
        };
        OfferCard: {
            offer_id: string;
            catalog_version: components["schemas"]["Uuid"];
            name: string;
            /** Format: uri */
            product_url: string;
            price: components["schemas"]["Price"] | null;
            /** @enum {unknown} */
            availability: "available" | "unavailable" | "unknown";
            /** @description Сервер разрешает выбрать позицию. Позиция со статусом unavailable доступна для выбора при подтверждённой цене. */
            selectable?: boolean;
            attributes: Record<string, never>;
            source_ids: string[];
        };
        PriceTerms: {
            base_amount: string;
            /** @description Подтверждённый процент скидки от 0 до 5 */
            discount_percent: string;
            final_amount: string;
            currency: string;
        };
        Price: {
            amount: string;
            currency: string;
        };
        Source: {
            id: string;
            title: string;
            /** Format: uri */
            url: string;
            /** @enum {unknown} */
            kind: "catalog" | "store" | "knowledge";
            /** Format: date-time */
            snapshot_at?: string;
            /** Format: date-time */
            checked_at?: string;
        } | unknown | unknown;
        /** @enum {unknown} */
        Outcome: "clarify" | "recommend" | "answer" | "insufficient_data";
        Error: {
            code: string;
            message: string;
            request_id: string;
            turn_id?: components["schemas"]["Uuid"];
            updated_offer?: components["schemas"]["OfferCard"];
        };
        AcceptedEvent: {
            turn_id: components["schemas"]["Uuid"];
            client_message_id: components["schemas"]["Uuid"];
            user_message_id: components["schemas"]["Uuid"];
            request_id: string;
        };
        StatusEvent: {
            /** @enum {unknown} */
            stage: "interpreting" | "searching" | "generating";
        };
        DeltaEvent: {
            seq: number;
            text: string;
        };
        DoneEvent: {
            turn_id: components["schemas"]["Uuid"];
            outcome: components["schemas"]["Outcome"];
            message: components["schemas"]["Message"];
        };
        FailedEvent: {
            turn_id: components["schemas"]["Uuid"];
            code: string;
            message: string;
            retryable: boolean;
        };
    };
    responses: {
        /** @description Ошибка до открытия SSE */
        Error: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description Состояние локального сервиса */
        Health: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": {
                    /** @enum {unknown} */
                    status: "up" | "down";
                };
            };
        };
    };
    parameters: {
        SessionId: components["schemas"]["Uuid"];
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    createSession: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Сессия создана */
            201: {
                headers: {
                    /** @description Токен softline_session с атрибутами HttpOnly, Secure и SameSite=Lax. */
                    "Set-Cookie"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        session_id: components["schemas"]["Uuid"];
                    };
                };
            };
            403: components["responses"]["Error"];
            429: components["responses"]["Error"];
        };
    };
    getSession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Сохранённая история, выбранное предложение и состояние хода */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Session"];
                };
            };
            404: components["responses"]["Error"];
        };
    };
    submitMessage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    client_message_id: components["schemas"]["Uuid"];
                    text: string;
                    retry_of_turn_id?: components["schemas"]["Uuid"];
                };
            };
        };
        responses: {
            /** @description SSE с JSON в data. Поток начинает accepted и завершает done или failed. Между ними возможны status, delta и heartbeat-комментарии. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/event-stream": string;
                };
            };
            400: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
            /** @description Ход выполняется или идентификатор уже связан с другим телом */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": "TURN_IN_PROGRESS",
                     *       "message": "Текущий ход ещё выполняется.",
                     *       "request_id": "req-0042",
                     *       "turn_id": "e3d1701c-1210-4706-94cb-2b9ec088da3d"
                     *     }
                     */
                    "application/json": components["schemas"]["Error"];
                };
            };
            429: components["responses"]["Error"];
            503: components["responses"]["Error"];
        };
    };
    selectOffer: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    offer_id: string;
                    catalog_version: components["schemas"]["Uuid"];
                };
            };
        };
        responses: {
            /** @description Выбор сохранён */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OfferCard"];
                };
            };
            400: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
            409: components["responses"]["Error"];
            503: components["responses"]["Error"];
        };
    };
    createQuoteDraft: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["QuoteRequest"];
            };
        };
        responses: {
            /** @description PDF коммерческого предложения */
            200: {
                headers: {
                    "Content-Disposition"?: string;
                    /** @description Идентификатор сохранённой версии КП. */
                    "X-Quote-Id"?: components["schemas"]["Uuid"];
                    /** @description Доступность счёта после одобрения КП. */
                    "X-Invoice-Drafts-Enabled"?: boolean;
                    [name: string]: unknown;
                };
                content: {
                    "application/pdf": string;
                };
            };
            400: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
            409: components["responses"]["Error"];
            429: components["responses"]["Error"];
            503: components["responses"]["Error"];
        };
    };
    approveQuoteDraft: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: components["parameters"]["SessionId"];
                quote_id: components["schemas"]["Uuid"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Условия КП подтверждены */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
            409: components["responses"]["Error"];
            429: components["responses"]["Error"];
            503: components["responses"]["Error"];
        };
    };
    createInvoiceDraft: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["InvoiceDraftRequest"];
            };
        };
        responses: {
            /** @description PDF счёта для согласования */
            200: {
                headers: {
                    "Content-Disposition"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/pdf": string;
                };
            };
            400: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
            409: components["responses"]["Error"];
            429: components["responses"]["Error"];
            503: components["responses"]["Error"];
        };
    };
    liveness: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Health"];
        };
    };
    readiness: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Health"];
            503: components["responses"]["Health"];
        };
    };
}
