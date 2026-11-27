package ru.softline.support.chat;

import static ru.softline.support.chat.ChatTypes.*;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.softline.support.catalog.CatalogSearch;

@Service
class ChatStore {
    private static final String TURNS = """
        SELECT t.*, u.body AS user_text
        FROM chat_turns t JOIN chat_messages u ON u.message_id = t.user_message_id
        """;
    private static final String EXPIRE = """
        WITH expired AS (
            UPDATE chat_turns SET status = 'failed', error_code = 'TURN_TIMEOUT'
            WHERE status = 'running' AND deadline_at <= clock_timestamp() %s
            RETURNING turn_id
        )
        UPDATE chat_messages SET status = 'partial'
        WHERE status = 'streaming' AND turn_id IN (SELECT turn_id FROM expired)
        """;
    private final JdbcClient db;
    private final ObjectMapper json;
    private final CatalogSearch catalog;
    private final DocumentDraftPdf draftPdf;
    private final boolean quotesEnabled;
    private final boolean invoiceDraftsEnabled;
    private final BigDecimal discountLimit;
    private final SecureRandom random = new SecureRandom();

    ChatStore(JdbcClient db, ObjectMapper json, CatalogSearch catalog, DocumentDraftPdf draftPdf,
              @Value("${chat.quotes-enabled:false}") boolean quotesEnabled,
              @Value("${chat.invoice-drafts-enabled:false}") boolean invoiceDraftsEnabled,
              @Value("${chat.discount-percent:0}") BigDecimal discountLimit) {
        this.db = db;
        this.json = json;
        this.catalog = catalog;
        this.draftPdf = draftPdf;
        this.quotesEnabled = quotesEnabled;
        this.invoiceDraftsEnabled = invoiceDraftsEnabled;
        if (discountLimit.signum() < 0 || discountLimit.compareTo(BigDecimal.valueOf(5)) > 0
                || discountLimit.stripTrailingZeros().scale() > 2) {
            throw new IllegalArgumentException("CHAT_DISCOUNT_PERCENT must be between 0 and 5");
        }
        this.discountLimit = discountLimit;
    }

    Owner create(String cookie) {
        String token = cookie;
        if (token == null || !token.matches("[A-Za-z0-9_-]{43}")) {
            byte[] bytes = new byte[32];
            random.nextBytes(bytes);
            token = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        }
        UUID id = UUID.randomUUID();
        db.sql("INSERT INTO chat_sessions (session_id, token_hash) VALUES (?, ?)")
                .params(id, tokenHash(token)).update();
        return new Owner(id, token);
    }

    @EventListener(ApplicationReadyEvent.class)
    public void expireOldTurns() {
        db.sql(EXPIRE.formatted("")).update();
    }

    @Transactional
    public Session read(UUID id, String token) {
        lockOwner(id, token);
        expire(id);
        PublicTurn last = db.sql(TURNS + " WHERE t.session_id = ? ORDER BY t.deadline_at DESC LIMIT 1")
                .param(id).query(this::turn).optional().map(Turn::publicView).orElse(null);
        JsonNode chosen = db.sql("SELECT COALESCE(selected_card, 'null'::jsonb)::text FROM chat_sessions WHERE session_id = ?")
                .param(id).query(String.class).optional().map(this::tree).orElse(null);
        return new Session(id, messages(id, Long.MAX_VALUE), chosen, last, quotesEnabled, supportTopic(id), priceTerms(chosen, pricing(id).percent()));
    }

    List<Message> messages(UUID id, long throughOrdinal) {
        return db.sql("SELECT * FROM chat_messages WHERE session_id = ? AND ordinal <= ? ORDER BY ordinal")
                .params(id, throughOrdinal).query(this::message).list();
    }

    @Transactional
    public HandoffStatus handoffStatus(UUID id, String token) {
        lockOwner(id, token);
        Handoff handoff = db.sql("""
            SELECT handoff_id, reason, status, created_at FROM chat_handoffs WHERE session_id = ?
            ORDER BY created_at DESC, handoff_id DESC LIMIT 1
            """).param(id).query((rs, n) -> new Handoff(rs.getObject("handoff_id", UUID.class),
                rs.getString("reason"), rs.getString("status"), instant(rs, "created_at"))).optional().orElse(null);
        return new HandoffStatus(handoff);
    }

    Reply pricingReply(Turn turn, MlClient.Interpretation interpretation) {
        String text = FaqText.key(turn.userText());
        boolean objection = text.matches("(?s).*(мне дорого|нам дорого|слишком дорог|слишком высок[а-я]* цен|дороговато|выше (моего|нашего) бюджета).*")
                || !text.contains("не дорого") && ReplyPlanner.signal(interpretation, "price_objection", turn.userText());
        String coupon = text.matches("(?s).*(нет (?:купона|промокода)|(?:купона|промокода) нет|без (?:купона|промокода)).*")
                ? "absent" : text.matches("(?s).*(есть (?:купон|промокод)|(?:купон|промокод) есть|у меня (?:купон|промокод)).*")
                ? "present" : null;
        boolean priceQuestion = text.matches("(?s)^(?:а )?(?:сколько (?:это )?стоит|какая цена|назовите цену)"
                + "(?: (?:купона нет|промокода нет|нет купона|нет промокода))?$");
        if (!objection && coupon == null && !priceQuestion) return null;
        PricingState previous = pricing(turn.sessionId());
        JsonNode selected = selectedCard(turn.sessionId());
        if (!selected.path("price").isObject()) {
            return objection ? Reply.text("clarify", "Выберите позицию с ценой, чтобы обсудить условия покупки.") : null;
        }
        JsonNode current = catalog.card(turn.catalogVersion(), selected.path("offer_id").asText()).orElse(null);
        if (current == null || !CatalogSearch.canSelect(current) || !sameTerms(selected, current)) {
            return Reply.text("clarify", "Цена или условия выбранной позиции изменились. Запросите актуальное предложение.");
        }
        String couponState = coupon == null ? previous.coupon() : coupon;
        if (priceQuestion) {
            DocumentDraft draft = documentDraft(current, "", 1, BigDecimal.ZERO, null);
            String answer = "Базовая цена выбранной позиции по каталогу " + draft.unitPrice().toPlainString()
                    + " " + draft.currency() + ".";
            return Reply.text("answer", answer);
        }
        if (!objection && !previous.objection()) {
            return new Reply("answer", List.of(new Fact("f1", "Уточнение о купоне сохранено для выбранной позиции.")),
                    List.of(), List.of(), null, null, new PricingState(false, couponState, BigDecimal.ZERO));
        }
        BigDecimal percent = "absent".equals(couponState) ? discountLimit : BigDecimal.ZERO;
        PriceTerms terms = priceTerms(current, percent);
        String answer;
        if (couponState == null) answer = "У вас есть купон или промокод на эту покупку?";
        else if ("present".equals(couponState)) answer = "Вы можете проверить условия купона или промокода при оформлении заказа.";
        else if (terms == null) answer = "Скидка на эту покупку сейчас не настроена.";
        else answer = "Предлагаю скидку " + terms.discountPercent() + "%. Базовая цена за позицию "
                + terms.baseAmount() + " " + terms.currency() + ", со скидкой "
                + terms.finalAmount() + " " + terms.currency() + ". Итог по количеству будет в КП.";
        return new Reply("answer", List.of(new Fact("f1", answer)), List.of(), List.of(), null, null,
                new PricingState(true, couponState, percent));
    }

    private PricingState pricing(UUID session) {
        return db.sql("SELECT price_objection, coupon_state, discount_percent FROM chat_sessions WHERE session_id = ?")
                .param(session).query((rs, row) -> new PricingState(rs.getBoolean("price_objection"),
                        rs.getString("coupon_state"), rs.getBigDecimal("discount_percent"))).single();
    }

    private static PriceTerms priceTerms(JsonNode card, BigDecimal discount) {
        if (discount.signum() == 0 || !card.path("price").isObject()) return null;
        DocumentDraft draft = documentDraft(card, "", 1, discount, null);
        return new PriceTerms(draft.unitPrice().toPlainString(), discount.stripTrailingZeros().toPlainString(),
                draft.discountedUnitPrice().stripTrailingZeros().toPlainString(), draft.currency());
    }

    String supportTopic(UUID session) {
        return db.sql("SELECT support_topic FROM chat_sessions WHERE session_id = ?")
                .param(session).query(String.class).optional().orElse(null);
    }

    String activeHandoffReason(UUID id) {
        return db.sql("SELECT reason FROM chat_handoffs WHERE session_id = ? AND status <> 'resolved'")
                .param(id).query(String.class).optional().orElse(null);
    }

    @Transactional
    public Accepted reserve(UUID id, String token, Send input, long timeoutMillis) {
        lockOwner(id, token);
        expire(id);
        Turn existing = db.sql(TURNS + " WHERE t.session_id = ? AND t.client_message_id = ?")
                .params(id, input.clientMessageId()).query(this::turn).optional().orElse(null);
        if (existing != null) {
            if (!existing.userText().equals(input.text()) || !Objects.equals(existing.retryOfTurnId(), input.retryOfTurnId())) {
                throw new ChatError(409, "IDEMPOTENCY_CONFLICT", "Идентификатор уже используется другим запросом.", existing.turnId(), null);
            }
            if ("running".equals(existing.status())) throw inProgress(existing.turnId());
            return new Accepted(existing, true);
        }
        requireIdle(id);
        UUID version = catalog.activeVersion().orElseThrow(
                () -> new ChatError(503, "CATALOG_UNAVAILABLE", "Каталог ещё загружается."));
        UUID userMessageId = UUID.randomUUID();
        if (input.retryOfTurnId() == null) {
            db.sql("""
                INSERT INTO chat_messages (message_id, session_id, role, body, status)
                VALUES (?, ?, 'user', ?, 'complete')
                """).params(userMessageId, id, input.text()).update();
        } else {
            Turn previous = db.sql(TURNS + " WHERE t.session_id = ? AND t.turn_id = ?")
                    .params(id, input.retryOfTurnId()).query(this::turn).optional().orElse(null);
            if (previous == null || !"failed".equals(previous.status()) || !previous.retryable()
                    || !previous.userText().equals(input.text())) {
                throw new ChatError(400, "INVALID_RETRY", "Повторите исходную реплику завершившегося ошибкой хода.");
            }
            userMessageId = previous.userMessageId();
        }
        UUID turnId = UUID.randomUUID();
        String requestId = UUID.randomUUID().toString();
        OffsetDateTime deadline = OffsetDateTime.now(ZoneOffset.UTC).plusNanos(timeoutMillis * 1_000_000);
        db.sql("""
            INSERT INTO chat_turns (turn_id, session_id, client_message_id, request_id, user_message_id,
                catalog_import_id, status, deadline_at, retry_of_turn_id)
            VALUES (:turn, :session, :client, :request, :message, :version, 'running', :deadline, :retry)
            """).param("turn", turnId).param("session", id).param("client", input.clientMessageId())
                .param("request", requestId).param("message", userMessageId).param("version", version)
                .param("deadline", deadline).param("retry", input.retryOfTurnId()).update();
        return new Accepted(new Turn(turnId, id, input.clientMessageId(), requestId, userMessageId, version,
                "running", null, deadline.toInstant(), input.retryOfTurnId(), null, true, input.text()), false);
    }

    Map<String, Object> requirements(Turn turn) {
        return decode(db.sql("SELECT requirements::text FROM chat_sessions WHERE session_id = ?")
                .param(turn.sessionId()).query(String.class).single(), new TypeReference<>() {});
    }

    List<Map<String, String>> context(Turn turn) {
        return db.sql("""
            SELECT role, body FROM (
                SELECT role, body, ordinal FROM chat_messages
                WHERE session_id = ? AND status = 'complete' AND message_id <> ? AND handoff_id IS NULL
                ORDER BY ordinal DESC LIMIT 8
            ) messages ORDER BY ordinal
            """).params(turn.sessionId(), turn.userMessageId())
                .query((rs, n) -> Map.of("role", rs.getString("role"), "text", clip(rs.getString("body"), 1200))).list();
    }

    @Transactional
    public int append(Turn turn, String text) {
        lockRunning(turn);
        return db.sql("""
            INSERT INTO chat_messages (message_id, session_id, turn_id, role, body, status, last_seq)
            VALUES (?, ?, ?, 'assistant', ?, 'streaming', 1)
            ON CONFLICT (turn_id) DO UPDATE SET
                body = chat_messages.body || excluded.body, last_seq = chat_messages.last_seq + 1
            RETURNING last_seq
            """).params(UUID.randomUUID(), turn.sessionId(), turn.turnId(), text).query(Integer.class).single();
    }

    @Transactional
    public Done complete(Turn turn, Reply reply, Map<String, Object> requirements, boolean changed,
                         String modelVersion, String promptVersion) {
        lockRunning(turn);
        if (reply.handoffReason() != null) saveHandoff(turn, reply);
        if (reply.pricing() != null) {
            PricingState pricing = reply.pricing();
            db.sql("""
                UPDATE chat_sessions SET price_objection = ?, coupon_state = ?, discount_percent = ? WHERE session_id = ?
                """).params(pricing.objection(), pricing.coupon(), pricing.percent(), turn.sessionId()).update();
        }
        Message answer = db.sql("""
            UPDATE chat_messages SET status = 'complete', cards = CAST(? AS jsonb), sources = CAST(? AS jsonb)
            WHERE turn_id = ? RETURNING *
            """).params(encode(reply.cards()), encode(reply.sources()), turn.turnId()).query(this::message).single();
        db.sql("""
            UPDATE chat_turns SET status = 'complete', outcome = :outcome, model_version = :model, prompt_version = :prompt
            WHERE turn_id = :id
            """).param("outcome", reply.outcome()).param("model", modelVersion).param("prompt", promptVersion)
                .param("id", turn.turnId()).update();
        db.sql("""
            UPDATE chat_sessions SET requirements = CAST(? AS jsonb), updated_at = now(),
                selected_import_id = CASE WHEN ? THEN NULL ELSE selected_import_id END,
                selected_offer_id = CASE WHEN ? THEN NULL ELSE selected_offer_id END,
                selected_card = CASE WHEN ? THEN NULL ELSE selected_card END,
                pending_offer = CASE WHEN ? THEN NULL ELSE pending_offer END,
                support_topic = CASE WHEN ? THEN NULL ELSE COALESCE(?, support_topic) END,
                price_objection = CASE WHEN ? THEN false ELSE price_objection END,
                coupon_state = CASE WHEN ? THEN NULL ELSE coupon_state END,
                discount_percent = CASE WHEN ? THEN 0 ELSE discount_percent END
            WHERE session_id = ?
            """).params(encode(requirements), changed, changed, changed, changed, reply.handoffReason() != null,
                    reply.supportTopic(), changed, changed, changed, turn.sessionId()).update();
        return new Done(turn.turnId(), reply.outcome(), answer);
    }

    private void saveHandoff(Turn turn, Reply reply) {
        db.sql("""
            INSERT INTO chat_handoffs (handoff_id, session_id, opening_turn_id, reason, status, sales_context)
            SELECT ?, s.session_id, ?, ?, 'queued', CASE WHEN ? = 'payment_deferral' THEN jsonb_build_object(
                'offer', s.selected_card,
                'quote', (SELECT jsonb_build_object('quote_id', q.quote_id, 'quantity', q.quantity,
                    'approved', q.approved_at IS NOT NULL, 'discount_percent', q.discount_percent::text,
                    'price', q.offer_card->'price', 'agreed_total', q.agreed_total::text)
                    FROM quote_drafts q WHERE q.session_id = s.session_id AND q.invalidated_at IS NULL
                        AND q.offer_card->>'offer_id' = s.selected_offer_id
                    ORDER BY q.created_at DESC LIMIT 1)
            ) END
            FROM chat_sessions s WHERE s.session_id = ?
            ON CONFLICT (session_id) WHERE status <> 'resolved' DO NOTHING
            """).params(UUID.randomUUID(), turn.turnId(), reply.handoffReason(), reply.handoffReason(), turn.sessionId()).update();
        UUID handoff = db.sql("SELECT handoff_id FROM chat_handoffs WHERE session_id = ? AND status <> 'resolved'")
                .param(turn.sessionId()).query(UUID.class).single();
        db.sql("UPDATE chat_messages SET handoff_id = ? WHERE message_id = ?")
                .params(handoff, turn.userMessageId()).update();
        db.sql("""
            INSERT INTO chat_messages (message_id, session_id, turn_id, role, body, status, handoff_id)
            VALUES (?, ?, ?, 'assistant', ?, 'complete', ?)
            """).params(UUID.randomUUID(), turn.sessionId(), turn.turnId(), reply.facts().getFirst().text(), handoff).update();
    }

    @Transactional
    public void fail(Turn turn, String code, boolean retryable) {
        int count = db.sql("""
            UPDATE chat_turns SET status = 'failed', error_code = ?, retryable = ?
            WHERE turn_id = ? AND status = 'running'
            """).params(code, retryable, turn.turnId()).update();
        if (count == 1) {
            db.sql("UPDATE chat_messages SET status = 'partial' WHERE turn_id = ? AND status = 'streaming'")
                    .param(turn.turnId()).update();
        }
    }

    Done savedAnswer(Turn turn) {
        Message message = db.sql("SELECT * FROM chat_messages WHERE turn_id = ?")
                .param(turn.turnId()).query(this::message).single();
        return new Done(turn.turnId(), turn.outcome(), message);
    }

    @Transactional(noRollbackFor = ChatError.class)
    public JsonNode select(UUID id, String token, Choose selection) {
        lockOwner(id, token);
        expire(id);
        requireIdle(id);
        JsonNode previous = db.sql("""
            SELECT item::text FROM chat_messages m
            CROSS JOIN LATERAL jsonb_array_elements(m.cards) AS item
            WHERE m.session_id = ? AND m.status = 'complete'
                AND item->>'offer_id' = ? AND item->>'catalog_version' = ?
            ORDER BY ordinal DESC LIMIT 1
            """).params(id, selection.offerId(), selection.catalogVersion().toString()).query(String.class)
                .optional().map(this::tree).orElseGet(() -> pendingOffer(id, selection));
        JsonNode current = revalidateOffer(id, previous);
        JsonNode earlier = selectedCard(id);
        boolean sameSelection = current.path("offer_id").equals(earlier.path("offer_id")) && sameTerms(earlier, current);
        db.sql("""
            UPDATE chat_sessions SET selected_import_id = ?, selected_offer_id = ?, selected_card = CAST(? AS jsonb),
                pending_offer = NULL, updated_at = now(),
                price_objection = ? AND price_objection,
                coupon_state = CASE WHEN ? THEN coupon_state ELSE NULL END,
                discount_percent = CASE WHEN ? THEN discount_percent ELSE 0 END
            WHERE session_id = ?
            """).params(UUID.fromString(current.path("catalog_version").asText()), selection.offerId(),
                encode(current), sameSelection, sameSelection, sameSelection, id).update();
        return current;
    }

    @Transactional(noRollbackFor = ChatError.class, rollbackFor = IOException.class)
    public QuotePdf createQuote(UUID id, String token, DocumentDraftRequest input) throws IOException {
        lockOwner(id, token);
        if (!quotesEnabled) {
            throw new ChatError(404, "QUOTES_DISABLED", "Формирование КП пока недоступно.");
        }
        if (input == null || input.customerName() == null || input.customerName().isBlank()
                || input.customerName().length() > 160 || input.customerName().codePoints()
                        .anyMatch(point -> Character.isISOControl(point) || Character.getType(point) == Character.FORMAT)
                || input.quantity() == null || input.quantity().compareTo(BigDecimal.ONE) < 0
                || input.quantity().compareTo(BigDecimal.valueOf(99_999)) > 0 || input.quantity().stripTrailingZeros().scale() > 0) {
            throw ChatErrors.invalid();
        }
        expire(id);
        requireIdle(id);
        JsonNode selected = selectedCard(id);
        if (selected.isNull()) {
            throw new ChatError(409, "QUOTE_SELECTION_REQUIRED", "Сначала подтвердите предложение из каталога.");
        }
        JsonNode card = revalidateOffer(id, selected);
        if (!card.path("price").isObject()) {
            throw new ChatError(409, "QUOTE_PRICE_UNAVAILABLE", "Для этой позиции менеджер должен подтвердить цену.");
        }
        String customer = input.customerName().strip();
        int quantity = input.quantity().intValueExact();
        UUID quoteId = UUID.randomUUID();
        BigDecimal discount = pricing(id).percent();
        DocumentDraft draft = documentDraft(card, customer, quantity, discount, null);
        byte[] pdf = draftPdf.render(draft, DraftKind.QUOTE, quoteId);
        db.sql("UPDATE quote_drafts SET invalidated_at = now() WHERE session_id = ? AND invalidated_at IS NULL")
                .param(id).update();
        db.sql("""
            INSERT INTO quote_drafts (quote_id, session_id, offer_card, customer_name, quantity, discount_percent, agreed_total)
            VALUES (?, ?, CAST(? AS jsonb), ?, ?, ?, ?)
            """).params(quoteId, id, encode(card), customer, quantity, discount, draft.total()).update();
        return new QuotePdf(quoteId, invoiceDraftsEnabled, pdf);
    }

    @Transactional(noRollbackFor = ChatError.class)
    public void approveQuote(UUID id, String token, UUID quoteId) {
        lockOwner(id, token);
        SavedQuote quote = findQuote(id, quoteId);
        requireCurrentQuote(id, quoteId, quote);
        if (!quote.approved()) {
            db.sql("UPDATE quote_drafts SET approved_at = now() WHERE quote_id = ?").param(quoteId).update();
        }
    }

    @Transactional(noRollbackFor = ChatError.class, rollbackFor = IOException.class)
    public byte[] issueInvoice(UUID id, String token, InvoiceDraftRequest input) throws IOException {
        lockOwner(id, token);
        if (!invoiceDraftsEnabled) {
            throw new ChatError(404, "INVOICE_DRAFTS_DISABLED", "Формирование счёта пока недоступно.");
        }
        if (input == null || input.quoteId() == null) throw ChatErrors.invalid();
        UUID quoteId = input.quoteId();
        SavedQuote quote = findQuote(id, quoteId);
        // The session lock serializes the first issue and concurrent replays.
        if (quote.invoice() != null) return quote.invoice();
        requireCurrentQuote(id, quoteId, quote);
        if (!quote.approved()) {
            throw new ChatError(409, "QUOTE_APPROVAL_REQUIRED", "Сначала одобрите это коммерческое предложение.");
        }
        DocumentDraft draft = documentDraft(quote.card(), quote.customer(), quote.quantity(), quote.discount(), quote.total());
        byte[] pdf = draftPdf.render(draft, DraftKind.INVOICE, quoteId);
        db.sql("UPDATE quote_drafts SET invoice_pdf = ? WHERE quote_id = ?").params(pdf, quoteId).update();
        return pdf;
    }

    private record SavedQuote(JsonNode card, String customer, int quantity, boolean approved,
                              boolean invalidated, byte[] invoice, BigDecimal discount, BigDecimal total) {}

    private SavedQuote findQuote(UUID id, UUID quoteId) {
        return db.sql("""
            SELECT offer_card::text, customer_name, quantity, approved_at, invalidated_at, invoice_pdf, discount_percent, agreed_total
            FROM quote_drafts WHERE session_id = ? AND quote_id = ?
            """).params(id, quoteId).query((rs, row) -> new SavedQuote(tree(rs.getString("offer_card")),
                    rs.getString("customer_name"), rs.getInt("quantity"), rs.getTimestamp("approved_at") != null,
                    rs.getTimestamp("invalidated_at") != null, rs.getBytes("invoice_pdf"),
                    rs.getBigDecimal("discount_percent"), rs.getBigDecimal("agreed_total")))
                .optional().orElseThrow(() -> new ChatError(404, "QUOTE_NOT_FOUND", "Коммерческое предложение не найдено."));
    }

    private void requireCurrentQuote(UUID id, UUID quoteId, SavedQuote quote) {
        if (quote.invalidated()) throw supersededQuote();
        expire(id);
        requireIdle(id);
        if (!quote.card().path("offer_id").equals(selectedCard(id).path("offer_id"))
                || quote.discount().compareTo(pricing(id).percent()) != 0) {
            invalidateQuote(quoteId);
            throw supersededQuote();
        }
        try {
            revalidateOffer(id, quote.card());
        } catch (ChatError error) {
            if ("OFFER_CHANGED".equals(error.code)) invalidateQuote(quoteId);
            throw error;
        }
    }

    private void invalidateQuote(UUID quoteId) {
        db.sql("UPDATE quote_drafts SET invalidated_at = now() WHERE quote_id = ?").param(quoteId).update();
    }

    private static ChatError supersededQuote() {
        return new ChatError(409, "QUOTE_SUPERSEDED", "Сформируйте и одобрите новое коммерческое предложение.");
    }

    private JsonNode selectedCard(UUID id) {
        return db.sql("SELECT selected_card::text FROM chat_sessions WHERE session_id = ?")
                .param(id).query(String.class).optional().map(this::tree).orElseGet(json::nullNode);
    }

    private static DocumentDraft documentDraft(JsonNode card, String customer, int quantity,
                                               BigDecimal discount, BigDecimal total) {
        JsonNode price = card.path("price");
        return new DocumentDraft(customer, card.path("name").asText(),
                card.path("attributes").path("vendor_code").asText(""), quantity,
                new BigDecimal(price.path("amount").asText()), price.path("currency").asText(), discount, total);
    }

    private static boolean sameTerms(JsonNode left, JsonNode right) {
        return List.of("price", "availability", "attributes", "name", "product_url")
                .stream().allMatch(field -> Objects.equals(left.get(field), right.get(field)));
    }

    private JsonNode revalidateOffer(UUID id, JsonNode previous) {
        UUID active = catalog.activeVersion().orElseThrow(
                () -> new ChatError(503, "CATALOG_UNAVAILABLE", "Каталог ещё загружается."));
        JsonNode current = catalog.card(active, previous.path("offer_id").asText()).orElse(null);
        boolean changed = current == null || !sameTerms(previous, current);
        if (changed || !CatalogSearch.canSelect(current)) {
            JsonNode replacement = current != null && CatalogSearch.canSelect(current)
                    ? current : null;
            db.sql("UPDATE chat_sessions SET pending_offer = CAST(? AS jsonb) WHERE session_id = ?")
                    .params(encode(replacement), id).update();
            throw new ChatError(409, "OFFER_CHANGED", "Предложение изменилось. Проверьте параметры в каталоге.", null, replacement);
        }
        return current;
    }

    private JsonNode pendingOffer(UUID id, Choose selection) {
        return db.sql("""
            SELECT pending_offer::text FROM chat_sessions
            WHERE session_id = ? AND pending_offer->>'offer_id' = ? AND pending_offer->>'catalog_version' = ?
            """).params(id, selection.offerId(), selection.catalogVersion().toString()).query(String.class)
                .optional().map(this::tree).orElseThrow(
                        () -> new ChatError(404, "OFFER_NOT_SHOWN", "Такое предложение не показано в этой сессии."));
    }

    private void lockOwner(UUID id, String token) {
        if (token == null || !token.matches("[A-Za-z0-9_-]{43}") || db.sql(
                "SELECT session_id FROM chat_sessions WHERE session_id = ? AND token_hash = ? FOR UPDATE")
                .params(id, tokenHash(token)).query(UUID.class).optional().isEmpty()) {
            throw new ChatError(404, "SESSION_NOT_FOUND", "Сессия не найдена.");
        }
    }

    void requireIdle(UUID id) {
        db.sql("SELECT turn_id FROM chat_turns WHERE session_id = ? AND status = 'running'")
                .param(id).query(UUID.class).optional().ifPresent(turn -> { throw inProgress(turn); });
    }

    private static ChatError inProgress(UUID id) {
        return new ChatError(409, "TURN_IN_PROGRESS", "Текущий ход ещё выполняется.", id, null);
    }

    void expire(UUID id) {
        db.sql(EXPIRE.formatted("AND session_id = ?")).param(id).update();
    }

    private void lockRunning(Turn turn) {
        lockSession(turn.sessionId());
        if (db.sql("""
            SELECT turn_id FROM chat_turns WHERE turn_id = ? AND status = 'running'
                AND deadline_at > clock_timestamp() FOR UPDATE
            """).param(turn.turnId()).query(UUID.class).optional().isEmpty()) {
            throw new ChatError(409, "TURN_TIMEOUT", "Время хода истекло.");
        }
    }

    void lockSession(UUID id) {
        db.sql("SELECT session_id FROM chat_sessions WHERE session_id = ? FOR UPDATE").param(id).query(UUID.class).single();
    }

    private static String tokenHash(String text) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException(ex);
        }
    }

    private Turn turn(ResultSet rs, int row) throws SQLException {
        return new Turn(rs.getObject("turn_id", UUID.class), rs.getObject("session_id", UUID.class),
                rs.getObject("client_message_id", UUID.class), rs.getString("request_id"),
                rs.getObject("user_message_id", UUID.class), rs.getObject("catalog_import_id", UUID.class),
                rs.getString("status"), rs.getString("outcome"), instant(rs, "deadline_at"),
                rs.getObject("retry_of_turn_id", UUID.class), rs.getString("error_code"),
                rs.getBoolean("retryable"), rs.getString("user_text"));
    }

    Message message(ResultSet rs, int row) throws SQLException {
        String role = rs.getString("role");
        String sender = "assistant".equals(role) && rs.getObject("turn_id") == null ? "manager" : null;
        return new Message(rs.getObject("message_id", UUID.class), role, rs.getString("body"),
                rs.getString("status"), decode(rs.getString("cards"), new TypeReference<>() {}),
                decode(rs.getString("sources"), new TypeReference<>() {}), instant(rs, "created_at"), sender);
    }

    private static Instant instant(ResultSet rs, String field) throws SQLException {
        return rs.getObject(field, OffsetDateTime.class).toInstant();
    }

    private JsonNode tree(String value) {
        return decode(value, new TypeReference<>() {});
    }

    private <T> T decode(String value, TypeReference<T> type) {
        try {
            return json.readValue(value, type);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("Invalid chat JSON in storage", ex);
        }
    }

    private String encode(Object value) {
        try {
            return json.writeValueAsString(value);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("Cannot serialize chat state", ex);
        }
    }

    private static String clip(String text, int max) {
        return text.length() <= max ? text : text.substring(0, text.offsetByCodePoints(0, Math.min(max, text.codePointCount(0, text.length()))));
    }
}
