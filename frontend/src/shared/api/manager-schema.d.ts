export interface paths {
    "/api/v1/sessions/{session_id}/handoff": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        /** @description Возвращает последнее обращение в собственной сессии. Реплики менеджера приходят в GET сессии с role=assistant и sender=manager. Пока обращение открыто, клиент отправляет уточнения обычным POST messages. Изменения можно опрашивать через GET. */
        get: operations["readSessionHandoff"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/manager/handoffs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Общая очередь и собственные обращения, сначала активные, затем закрытые. Содержимое диалога доступно после назначения. */
        get: operations["listHandoffs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/manager/handoffs/{handoff_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                handoff_id: components["parameters"]["HandoffId"];
            };
            cookie?: never;
        };
        get: operations["readAssignedHandoff"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/manager/handoffs/{handoff_id}/claim": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                handoff_id: components["parameters"]["HandoffId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description Назначает свободное обращение текущему менеджеру. Повтор для собственного активного обращения идемпотентен. */
        post: operations["claimHandoff"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/manager/handoffs/{handoff_id}/messages": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                handoff_id: components["parameters"]["HandoffId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description Сохраняет ответ своего обращения. Повтор с прежним message_id и тем же text возвращает сохранённую реплику. */
        post: operations["replyToHandoff"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/manager/handoffs/{handoff_id}/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                handoff_id: components["parameters"]["HandoffId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description Закрывает своё обращение. Повтор возвращает сохранённое состояние. Следующий запрос клиента снова обрабатывает ассистент. */
        post: operations["resolveHandoff"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/manager/handoffs/{handoff_id}/faq": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                handoff_id: components["parameters"]["HandoffId"];
            };
            cookie?: never;
        };
        /** @description Возвращает результат проверки для своего закрытого обращения. Если кандидата нет, возвращает candidate=null. */
        get: operations["readHandoffFaq"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/manager/handoffs/{handoff_id}/faq/approve": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                handoff_id: components["parameters"]["HandoffId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description Публикует исправленный общий ответ из needs_review со свежим источником из справки. Повтор с теми же данными возвращает опубликованную запись. FAQ_SOURCE_UNAVAILABLE означает, что требуется свежий источник, FAQ_DUPLICATE — что вопрос уже опубликован с той же областью применимости. */
        post: operations["approveHandoffFaq"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/manager/handoffs/{handoff_id}/faq/reject": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                handoff_id: components["parameters"]["HandoffId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description Отклоняет кандидата, ожидающего ручной проверки. */
        post: operations["rejectHandoffFaq"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/manager/handoffs/{handoff_id}/faq/unpublish": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                handoff_id: components["parameters"]["HandoffId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description Снимает опубликованный FAQ с поиска. Сохраняет связь с обращением. */
        post: operations["unpublishHandoffFaq"];
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
        ChatMessage: components["schemas"]["Message"] & {
            /**
             * @description Присутствует у ответа менеджера
             * @constant
             */
            sender?: "manager";
        };
        Handoff: {
            handoff_id: components["schemas"]["Uuid"];
            /** @enum {unknown} */
            reason: "document_review" | "off_catalog_order" | "instruction_failed" | "payment_deferral";
            /** @enum {unknown} */
            status: "queued" | "in_progress" | "resolved";
            /** Format: date-time */
            created_at: string;
        };
        QueueItem: components["schemas"]["Handoff"] & {
            session_id: components["schemas"]["Uuid"];
        };
        SalesContext: {
            offer: components["schemas"]["OfferCard"] | null;
            quote: {
                quote_id: components["schemas"]["Uuid"];
                quantity: number;
                approved: boolean;
                discount_percent?: string;
                agreed_total?: string | null;
                price?: components["schemas"]["Price"] | null;
            } | null;
        };
        FaqApproval: {
            question: string;
            answer: string;
            /** Format: uuid */
            source_id: string;
            product?: string;
            /** @description Допустима вместе с продуктом */
            edition?: string;
        };
        FaqCandidate: {
            /** Format: uuid */
            candidate_id: string;
            /** @enum {unknown} */
            status: "queued" | "published" | "needs_review" | "case_specific" | "rejected" | "unpublished";
            reason_code?: string | null;
            attempts: number;
            question?: string | null;
            answer?: string | null;
            product?: string | null;
            edition?: string | null;
            /** Format: uuid */
            source_id?: string | null;
            sources: {
                /** Format: uuid */
                id: string;
                title: string;
                /** Format: uri */
                url: string;
                text: string;
            }[];
        };
        /** Format: uuid */
        Uuid: string;
        Price: {
            amount: string;
            currency: string;
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
        Error: {
            code: string;
            message: string;
            request_id: string;
            turn_id?: components["schemas"]["Uuid"];
            updated_offer?: components["schemas"]["OfferCard"];
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
    };
    responses: {
        /** @description Состояние обращения */
        QueueItem: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["QueueItem"];
            };
        };
        /** @description Состояние кандидата и текущие выдержки справки */
        FaqReview: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": {
                    candidate: components["schemas"]["FaqCandidate"] | null;
                };
            };
        };
        /** @description Ошибка до открытия SSE */
        Error: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
    };
    parameters: {
        HandoffId: components["schemas"]["Uuid"];
        SessionId: components["schemas"]["Uuid"];
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    readSessionHandoff: {
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
            /** @description Статус обращения или null, если его ещё не было */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        handoff: components["schemas"]["Handoff"] | null;
                    };
                };
            };
            404: components["responses"]["Error"];
        };
    };
    listHandoffs: {
        parameters: {
            query?: {
                limit?: number;
                offset?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Страница очереди */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["QueueItem"][];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
        };
    };
    readAssignedHandoff: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                handoff_id: components["parameters"]["HandoffId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Назначенное менеджеру обращение с диалогом. В закрытом обращении видна переписка до момента закрытия. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        handoff: components["schemas"]["QueueItem"];
                        /** @description Снимок выбранной позиции и версии КП на момент передачи просьбы об отсрочке. */
                        sales_context?: components["schemas"]["SalesContext"] | null;
                        messages: components["schemas"]["ChatMessage"][];
                    };
                };
            };
            401: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    claimHandoff: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                handoff_id: components["parameters"]["HandoffId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["QueueItem"];
            401: components["responses"]["Error"];
            404: components["responses"]["Error"];
            409: components["responses"]["Error"];
        };
    };
    replyToHandoff: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                handoff_id: components["parameters"]["HandoffId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    message_id: components["schemas"]["Uuid"];
                    text: string;
                };
            };
        };
        responses: {
            /** @description Сохранённая реплика менеджера с sender=manager */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ChatMessage"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            404: components["responses"]["Error"];
            409: components["responses"]["Error"];
        };
    };
    resolveHandoff: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                handoff_id: components["parameters"]["HandoffId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["QueueItem"];
            401: components["responses"]["Error"];
            404: components["responses"]["Error"];
            409: components["responses"]["Error"];
        };
    };
    readHandoffFaq: {
        parameters: {
            query?: {
                /** @description Поиск свежих выдержек справки для ручной проверки */
                source_query?: string;
            };
            header?: never;
            path: {
                handoff_id: components["parameters"]["HandoffId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["FaqReview"];
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    approveHandoffFaq: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                handoff_id: components["parameters"]["HandoffId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["FaqApproval"];
            };
        };
        responses: {
            200: components["responses"]["FaqReview"];
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            404: components["responses"]["Error"];
            409: components["responses"]["Error"];
        };
    };
    rejectHandoffFaq: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                handoff_id: components["parameters"]["HandoffId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["FaqReview"];
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            404: components["responses"]["Error"];
            409: components["responses"]["Error"];
        };
    };
    unpublishHandoffFaq: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                handoff_id: components["parameters"]["HandoffId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["FaqReview"];
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            404: components["responses"]["Error"];
            409: components["responses"]["Error"];
        };
    };
}
