package ru.softline.support.chat;

import static ru.softline.support.chat.ChatTypes.*;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.softline.support.chat.FaqStore.FaqApproval;
import ru.softline.support.chat.FaqStore.FaqView;

@Service
class ManagerStore {
    private final JdbcClient db;
    private final ChatStore chat;
    private final FaqStore faq;

    ManagerStore(JdbcClient db, ChatStore chat, FaqStore faq) {
        this.db = db;
        this.chat = chat;
        this.faq = faq;
    }

    List<QueueItem> list(String manager, int limit, int offset) {
        return db.sql("""
            SELECT * FROM chat_handoffs WHERE status = 'queued' OR manager_id = ?
            ORDER BY (status = 'resolved'), created_at, handoff_id LIMIT ? OFFSET ?
            """).params(manager, limit, offset).query(ManagerStore::item).list();
    }

    @Transactional
    public AssignedHandoff read(UUID id, String manager) {
        Assigned assigned = lockAssigned(id, manager);
        return new AssignedHandoff(assigned.item(), chat.messages(assigned.item().sessionId(), assigned.throughOrdinal()));
    }

    @Transactional
    public QueueItem claim(UUID id, String manager) {
        Assignment current = db.sql("SELECT * FROM chat_handoffs WHERE handoff_id = ? FOR UPDATE")
                .param(id).query((rs, row) -> new Assignment(item(rs, row), rs.getString("manager_id")))
                .optional().orElseThrow(ManagerStore::missing);
        if ("queued".equals(current.item().status())) {
            return db.sql("""
                UPDATE chat_handoffs SET status = 'in_progress', manager_id = ? WHERE handoff_id = ? RETURNING *
                """).params(manager, id).query(ManagerStore::item).single();
        }
        if (manager.equals(current.manager()) && "in_progress".equals(current.item().status())) return current.item();
        throw new ChatError(409, "HANDOFF_NOT_AVAILABLE", "Обращение уже взято в работу или закрыто.");
    }

    @Transactional
    public Message reply(UUID id, String manager, ManagerMessage input) {
        QueueItem assigned = lockAssigned(id, manager).item();
        Message saved = savedReply(id, input.messageId());
        if (saved != null) return sameText(saved, input);
        if ("resolved".equals(assigned.status())) {
            throw new ChatError(409, "HANDOFF_RESOLVED", "Обращение уже закрыто.");
        }
        var inserted = db.sql("""
            INSERT INTO chat_messages (message_id, session_id, handoff_id, role, body, status)
            VALUES (?, ?, ?, 'assistant', ?, 'complete') ON CONFLICT (message_id) DO NOTHING RETURNING *
            """).params(input.messageId(), assigned.sessionId(), id, input.text()).query(chat::message).optional();
        return inserted.orElseThrow(ManagerStore::conflict);
    }

    @Transactional
    public QueueItem resolve(UUID id, String manager) {
        QueueItem assigned = lockAssigned(id, manager).item();
        if ("resolved".equals(assigned.status())) return assigned;
        chat.expire(assigned.sessionId());
        chat.requireIdle(assigned.sessionId());
        QueueItem resolved = db.sql("""
            UPDATE chat_handoffs h SET status = 'resolved', resolved_at = clock_timestamp(), closed_at_ordinal = (
                SELECT COALESCE(max(ordinal), 0) FROM chat_messages WHERE session_id = h.session_id
            ) WHERE h.handoff_id = ? RETURNING h.*
            """).param(id).query(ManagerStore::item).single();
        faq.enqueue(id);
        return resolved;
    }

    @Transactional
    public FaqView readFaq(UUID id, String manager, String query) {
        requireResolved(id, manager);
        return faq.read(id, query);
    }

    @Transactional
    public FaqView approveFaq(UUID id, String manager, FaqApproval approval) {
        requireResolved(id, manager);
        return faq.approve(id, manager, approval);
    }

    @Transactional
    public FaqView rejectFaq(UUID id, String manager) {
        requireResolved(id, manager);
        return faq.reject(id, manager);
    }

    @Transactional
    public FaqView unpublishFaq(UUID id, String manager) {
        requireResolved(id, manager);
        return faq.unpublish(id, manager);
    }

    private void requireResolved(UUID id, String manager) {
        if (!"resolved".equals(lockAssigned(id, manager).item().status())) {
            throw new ChatError(404, "FAQ_NOT_FOUND", "Проверка FAQ доступна для закрытого обращения.");
        }
    }

    private Assigned lockAssigned(UUID id, String manager) {
        UUID session = db.sql("SELECT session_id FROM chat_handoffs WHERE handoff_id = ? AND manager_id = ?")
                .params(id, manager).query(UUID.class).optional().orElseThrow(ManagerStore::missing);
        chat.lockSession(session);
        return db.sql("SELECT * FROM chat_handoffs WHERE handoff_id = ? AND manager_id = ?")
                .params(id, manager).query((rs, row) -> {
                    Long closedAt = rs.getObject("closed_at_ordinal", Long.class);
                    return new Assigned(item(rs, row), closedAt == null ? Long.MAX_VALUE : closedAt);
                }).optional().orElseThrow(ManagerStore::missing);
    }

    private Message savedReply(UUID handoff, UUID message) {
        return db.sql("""
            SELECT * FROM chat_messages WHERE handoff_id = ? AND message_id = ? AND role = 'assistant' AND turn_id IS NULL
            """).params(handoff, message).query(chat::message).optional().orElse(null);
    }

    private static Message sameText(Message saved, ManagerMessage input) {
        if (!saved.text().equals(input.text())) throw conflict();
        return saved;
    }

    private static ChatError conflict() {
        return new ChatError(409, "IDEMPOTENCY_CONFLICT", "Идентификатор уже используется другим сообщением.");
    }

    private static ChatError missing() {
        return new ChatError(404, "HANDOFF_NOT_FOUND", "Обращение не найдено.");
    }

    private static QueueItem item(ResultSet rs, int row) throws SQLException {
        return new QueueItem(rs.getObject("handoff_id", UUID.class), rs.getObject("session_id", UUID.class),
                rs.getString("reason"), rs.getString("status"), rs.getObject("created_at", OffsetDateTime.class).toInstant());
    }

    private record Assignment(QueueItem item, String manager) {}
    private record Assigned(QueueItem item, long throughOrdinal) {}
}
