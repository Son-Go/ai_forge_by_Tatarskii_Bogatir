package ru.softline.support.chat;

import static ru.softline.support.chat.ChatTypes.*;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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
    private final boolean quotesEnabled;
    private final SecureRandom random = new SecureRandom();

    ChatStore(JdbcClient db, ObjectMapper json, CatalogSearch catalog,
              @Value("${chat.quotes-enabled:false}") boolean quotesEnabled) {
        this.db = db;
        this.json = json;
        this.catalog = catalog;
        this.quotesEnabled = quotesEnabled;
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
        return new Session(id, messages(id, Long.MAX_VALUE), chosen, last, quotesEnabled);
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
                pending_offer = CASE WHEN ? THEN NULL ELSE pending_offer END
            WHERE session_id = ?
            """).params(encode(requirements), changed, changed, changed, changed, turn.sessionId()).update();
        return new Done(turn.turnId(), reply.outcome(), answer);
    }

    private void saveHandoff(Turn turn, Reply reply) {
        db.sql("""
            INSERT INTO chat_handoffs (handoff_id, session_id, opening_turn_id, reason, status)
            VALUES (?, ?, ?, ?, 'queued')
            ON CONFLICT (session_id) WHERE status <> 'resolved' DO NOTHING
            """).params(UUID.randomUUID(), turn.sessionId(), turn.turnId(), reply.handoffReason()).update();
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
        db.sql("""
            UPDATE chat_sessions SET selected_import_id = ?, selected_offer_id = ?, selected_card = CAST(? AS jsonb),
                pending_offer = NULL, updated_at = now() WHERE session_id = ?
            """).params(UUID.fromString(current.path("catalog_version").asText()), selection.offerId(),
                encode(current), id).update();
        return current;
    }

    @Transactional(noRollbackFor = ChatError.class)
    public QuoteDraft prepareQuote(UUID id, String token, QuoteRequest input) {
        lockOwner(id, token);
        if (!quotesEnabled) throw new ChatError(404, "QUOTES_DISABLED", "Черновики КП пока недоступны.");
        if (input == null || input.customerName() == null || input.customerName().isBlank()
                || input.customerName().length() > 160 || input.customerName().codePoints()
                        .anyMatch(point -> Character.isISOControl(point) || Character.getType(point) == Character.FORMAT)
                || input.quantity() == null || input.quantity().compareTo(BigDecimal.ONE) < 0
                || input.quantity().compareTo(BigDecimal.valueOf(99_999)) > 0 || input.quantity().stripTrailingZeros().scale() > 0) {
            throw ChatErrors.invalid();
        }
        expire(id);
        requireIdle(id);
        JsonNode selected = db.sql("SELECT selected_card::text FROM chat_sessions WHERE session_id = ?")
                .param(id).query(String.class).optional().map(this::tree).orElse(null);
        if (selected == null || selected.isNull()) {
            throw new ChatError(409, "QUOTE_SELECTION_REQUIRED", "Сначала подтвердите предложение из каталога.");
        }
        JsonNode current = revalidateOffer(id, selected);
        JsonNode price = current.path("price");
        if (!price.isObject()) {
            throw new ChatError(409, "QUOTE_PRICE_UNAVAILABLE", "Для этой позиции менеджер должен подтвердить цену.");
        }
        return new QuoteDraft(input.customerName().strip(), current.path("name").asText(),
                current.path("attributes").path("vendor_code").asText(""), input.quantity().intValueExact(),
                new BigDecimal(price.path("amount").asText()), price.path("currency").asText());
    }

    private JsonNode revalidateOffer(UUID id, JsonNode previous) {
        UUID active = catalog.activeVersion().orElseThrow(
                () -> new ChatError(503, "CATALOG_UNAVAILABLE", "Каталог ещё загружается."));
        JsonNode current = catalog.card(active, previous.path("offer_id").asText()).orElse(null);
        boolean changed = current == null || !List.of("price", "availability", "attributes", "name", "product_url")
                .stream().allMatch(field -> Objects.equals(previous.get(field), current.get(field)));
        if (changed || !"available".equals(current.path("availability").asText())) {
            JsonNode replacement = current != null && "available".equals(current.path("availability").asText())
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
