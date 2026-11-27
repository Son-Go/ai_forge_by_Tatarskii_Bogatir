package ru.softline.support.chat;

import static ru.softline.support.chat.ChatTypes.*;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.softline.support.catalog.CatalogSearch;
import ru.softline.support.catalog.CatalogSearch.Knowledge;

@Service
class FaqStore {
    private static final String MATCH = """
        SELECT f.answer, f.source_id FROM support_faq f
        JOIN knowledge_chunks c ON c.chunk_id = f.source_id
        JOIN knowledge_documents d USING (document_id)
        WHERE f.status = 'published'
          AND NOT EXISTS (SELECT 1 FROM knowledge_documents newer WHERE newer.source_url = d.source_url
              AND (newer.fetched_at, newer.document_id) > (d.fetched_at, d.document_id))
          AND (f.product_key IS NULL OR strpos(' ' || :question || ' ', ' ' || f.product_key || ' ') > 0)
          AND (f.edition_key IS NULL OR strpos(' ' || :question || ' ', ' ' || f.edition_key || ' ') > 0)
          AND (:product = '' OR f.product_key = :product OR f.product_key IS NULL AND f.question_key = :question)
          AND (:edition = '' OR f.edition_key = :edition OR f.edition_key IS NULL AND f.question_key = :question)
        """;
    private final JdbcClient db;
    private final CatalogSearch catalog;

    FaqStore(JdbcClient db, CatalogSearch catalog) {
        this.db = db;
        this.catalog = catalog;
    }

    void enqueue(UUID handoff) {
        db.sql("""
            WITH replies AS (
                SELECT m.*, count(*) FILTER (WHERE role = 'user') OVER () AS questions,
                    count(*) FILTER (WHERE role = 'assistant' AND turn_id IS NULL) OVER () AS answers
                FROM chat_messages m JOIN chat_handoffs h USING (handoff_id)
                WHERE h.handoff_id = ? AND m.session_id = h.session_id
                    AND m.ordinal <= h.closed_at_ordinal AND m.status = 'complete'
            ), answer AS (
                SELECT * FROM replies WHERE role = 'assistant' AND turn_id IS NULL ORDER BY ordinal DESC LIMIT 1
            ), pair AS (
                SELECT a.message_id AS answer_id, a.handoff_id, q.message_id AS question_id,
                    (a.questions = 1 AND a.answers = 1 AND q.message_id IS NOT NULL) AS unambiguous
                FROM answer a LEFT JOIN LATERAL (
                    SELECT message_id FROM replies
                    WHERE role = 'user' AND ordinal < a.ordinal ORDER BY ordinal DESC LIMIT 1
                ) q ON true
            )
            INSERT INTO support_faq_candidates
                (candidate_id, handoff_id, question_message_id, answer_message_id, status, reason_code, next_check_at)
            SELECT gen_random_uuid(), handoff_id, question_id, answer_id,
                CASE WHEN unambiguous THEN 'queued' ELSE 'needs_review' END,
                CASE WHEN NOT unambiguous THEN 'ambiguous_pair' END,
                CASE WHEN unambiguous THEN now() END
            FROM pair ON CONFLICT (handoff_id) DO NOTHING
            """).param(handoff).update();
    }

    @Transactional
    public Job claim(int leaseMs) {
        db.sql("""
            UPDATE support_faq_candidates SET status = 'needs_review', reason_code = 'review_unavailable',
                review_token = NULL, next_check_at = NULL
            WHERE status = 'queued' AND attempts = 3 AND next_check_at <= now()
            """).update();
        return db.sql("""
            WITH due AS (
                SELECT candidate_id FROM support_faq_candidates
                WHERE status = 'queued' AND next_check_at <= now() AND attempts < 3
                ORDER BY next_check_at, candidate_id LIMIT 1 FOR UPDATE SKIP LOCKED
            ), claimed AS (
                UPDATE support_faq_candidates f SET attempts = attempts + 1, review_token = gen_random_uuid(), reason_code = NULL,
                    next_check_at = now() + (? * interval '1 millisecond')
                FROM due WHERE f.candidate_id = due.candidate_id RETURNING f.*
            )
            SELECT c.candidate_id, c.review_token, q.body AS question, a.body AS answer
            FROM claimed c JOIN chat_messages q ON q.message_id = c.question_message_id
                JOIN chat_messages a ON a.message_id = c.answer_message_id
            """).param(leaseMs).query((rs, row) -> new Job(uuid(rs, "candidate_id"), uuid(rs, "review_token"),
                    rs.getString("question"), rs.getString("answer"))).optional().orElse(null);
    }

    void retry(Job job) {
        db.sql("""
            UPDATE support_faq_candidates SET status = CASE WHEN attempts = 3 THEN 'needs_review' ELSE 'queued' END,
                reason_code = 'review_unavailable', review_token = NULL,
                next_check_at = CASE WHEN attempts < 3 THEN now() + (attempts * interval '1 minute') END
            WHERE candidate_id = ? AND review_token = ?
            """).params(job.id(), job.token()).update();
    }

    @Transactional
    public void finish(Job job, String status, String reason, FaqApproval proposal, MlClient.FaqReview review) {
        boolean current = db.sql("""
            SELECT true FROM support_faq_candidates
            WHERE candidate_id = ? AND review_token = ? FOR UPDATE
            """).params(job.id(), job.token()).query(Boolean.class).optional().orElse(false);
        if (!current) return;
        if ("published".equals(status)) {
            if (catalog.currentKnowledge(List.of(proposal.sourceId())).isEmpty()) {
                status = "needs_review";
                reason = "stale_source";
            } else if (!publish(job.id(), proposal, null)) {
                status = "needs_review";
                reason = "duplicate_question";
            }
        }
        db.sql("""
            UPDATE support_faq_candidates SET status = ?, reason_code = ?, review_token = NULL, next_check_at = NULL,
                proposed_question = ?, proposed_answer = ?, proposed_source_id = ?, prompt_version = ?, model_version = ?
            WHERE candidate_id = ?
            """).params(status, reason, proposal == null ? null : proposal.question(), proposal == null ? null : proposal.answer(),
                proposal == null ? null : proposal.sourceId(), review == null ? null : review.promptVersion(),
                review == null ? null : review.modelVersion(), job.id()).update();
    }

    FaqView read(UUID handoff, String sourceQuery) {
        return new FaqView(db.sql("""
            SELECT c.candidate_id, c.status, c.reason_code, c.attempts,
                coalesce(f.question, c.proposed_question, q.body) AS question,
                coalesce(f.answer, c.proposed_answer, a.body) AS answer,
                coalesce(f.source_id, c.proposed_source_id) AS source_id, f.product, f.edition
            FROM support_faq_candidates c LEFT JOIN support_faq f USING (candidate_id)
                LEFT JOIN chat_messages q ON q.message_id = c.question_message_id
                JOIN chat_messages a ON a.message_id = c.answer_message_id
            WHERE c.handoff_id = ?
            """).param(handoff).query((rs, row) -> new Candidate(uuid(rs, "candidate_id"),
                    rs.getString("status"), rs.getString("reason_code"), rs.getInt("attempts"),
                    rs.getString("question"), rs.getString("answer"), uuid(rs, "source_id"),
                    rs.getString("product"), rs.getString("edition")))
                .optional().map(c -> withSources(c, sourceQuery)).orElse(null));
    }

    FaqView approve(UUID handoff, String manager, FaqApproval approval) {
        State state = lock(handoff);
        if ("published".equals(state.status())) {
            var current = read(handoff, null).candidate();
            if (approval.equals(new FaqApproval(current.question(), current.answer(), current.sourceId(),
                    current.product(), current.edition()))) return new FaqView(current);
            throw invalidTransition();
        }
        if (!"needs_review".equals(state.status())) throw invalidTransition();
        if (catalog.currentKnowledge(List.of(approval.sourceId())).isEmpty()) {
            throw new ChatError(409, "FAQ_SOURCE_UNAVAILABLE", "Выберите актуальную выдержку из справки.");
        }
        if (!publish(state.id(), approval, manager)) {
            throw new ChatError(409, "FAQ_DUPLICATE", "Для этого вопроса уже есть опубликованный ответ.");
        }
        setStatus(state.id(), "published", "manager_approved", manager);
        return read(handoff, null);
    }

    FaqView reject(UUID handoff, String manager) {
        State state = lock(handoff);
        if ("rejected".equals(state.status())) return read(handoff, null);
        if (!"needs_review".equals(state.status())) throw invalidTransition();
        setStatus(state.id(), "rejected", "manager_rejected", manager);
        return read(handoff, null);
    }

    FaqView unpublish(UUID handoff, String manager) {
        State state = lock(handoff);
        if ("unpublished".equals(state.status())) return read(handoff, null);
        if (!"published".equals(state.status())) throw invalidTransition();
        db.sql("""
            UPDATE support_faq SET status = 'unpublished', unpublished_at = now() WHERE candidate_id = ?
            """).param(state.id()).update();
        setStatus(state.id(), "unpublished", "manager_unpublished", manager);
        return read(handoff, null);
    }

    Reply lookup(String text, String product, String edition) {
        if (FaqText.privateData(text) || FaqText.caseSpecific(text) || FaqText.dynamic(text)) return null;
        String question = FaqText.key(text);
        if (question.isEmpty() || question.length() > 500) return null;
        List<Match> matches = matches(question, product, edition, true);
        if (matches.isEmpty() && question.length() >= 18) matches = matches(question, product, edition, false);
        if (matches.size() != 1) return null;
        Match match = matches.getFirst();
        return catalog.currentKnowledge(List.of(match.sourceId())).stream().findFirst()
                .map(source -> new Reply("answer", List.of(new Fact("f1", match.answer())), List.of(),
                        List.of(catalog.source(source)))).orElse(null);
    }

    boolean equivalent(String question, String proposed) {
        return db.sql("SELECT support_faq_terms(?) = support_faq_terms(?)")
                .params(FaqText.key(question), FaqText.key(proposed)).query(Boolean.class).single();
    }

    private List<Match> matches(String question, String product, String edition, boolean exact) {
        String filter = exact ? " AND f.question_key = :question" : """
            AND f.question_key % :question AND similarity(f.question_key, :question) >= 0.60
            AND support_faq_terms(f.question_key) = support_faq_terms(:question)
            """;
        return db.sql(MATCH + filter + " LIMIT 2").param("question", question)
                .param("product", product == null ? "" : FaqText.key(product))
                .param("edition", edition == null ? "" : FaqText.key(edition))
                .query((rs, row) -> new Match(rs.getString("answer"), uuid(rs, "source_id"))).list();
    }

    private CandidateView withSources(Candidate c, String query) {
        Map<UUID, Knowledge> sources = new LinkedHashMap<>();
        if (c.sourceId() != null) catalog.currentKnowledge(List.of(c.sourceId()))
                .forEach(source -> sources.put(source.id(), source));
        String sourceQuery = query != null ? query : c.question();
        if (sourceQuery != null && ("needs_review".equals(c.status()) || query != null)) {
            catalog.faqKnowledge(FaqText.key(FaqText.clip(sourceQuery, 200)))
                    .forEach(source -> sources.putIfAbsent(source.id(), source));
        }
        return new CandidateView(c.id(), c.status(), c.reason(), c.attempts(), c.question(), c.answer(),
                c.sourceId(), c.product(), c.edition(), sources.values().stream()
                    .map(source -> new Source(source.id(), source.title(), source.url(), FaqText.clip(source.text(), 1500))).toList());
    }

    private boolean publish(UUID id, FaqApproval approval, String manager) {
        return db.sql("""
            INSERT INTO support_faq (candidate_id, question, question_key, answer, product, product_key,
                edition, edition_key, source_id, status, approval_method, approved_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?) ON CONFLICT DO NOTHING
            """).params(id, approval.question(), FaqText.key(approval.question()), approval.answer(),
                approval.product(), approval.product() == null ? null : FaqText.key(approval.product()),
                approval.edition(), approval.edition() == null ? null : FaqText.key(approval.edition()),
                approval.sourceId(), manager == null ? "automatic" : "manager", manager).update() == 1;
    }

    private State lock(UUID handoff) {
        return db.sql("""
            SELECT candidate_id, status FROM support_faq_candidates WHERE handoff_id = ? FOR UPDATE
            """).param(handoff).query((rs, row) -> new State(uuid(rs, "candidate_id"), rs.getString("status")))
                .optional().orElseThrow(() -> new ChatError(404, "FAQ_NOT_FOUND", "Кандидат для FAQ не найден."));
    }

    private void setStatus(UUID id, String status, String reason, String manager) {
        db.sql("""
            UPDATE support_faq_candidates SET status = ?, reason_code = ?, reviewed_by = ? WHERE candidate_id = ?
            """).params(status, reason, manager, id).update();
    }

    private static ChatError invalidTransition() {
        return new ChatError(409, "FAQ_INVALID_STATE", "Это действие недоступно в текущем статусе кандидата.");
    }

    private static UUID uuid(ResultSet rs, String column) throws SQLException {
        return rs.getObject(column, UUID.class);
    }

    record Job(UUID id, UUID token, String question, String answer) {}
    record FaqApproval(String question, String answer, UUID sourceId, String product, String edition) {}
    record FaqView(CandidateView candidate) {}
    record CandidateView(UUID candidateId, String status, String reasonCode, int attempts, String question,
                         String answer, UUID sourceId, String product, String edition, List<Source> sources) {}
    record Source(UUID id, String title, String url, String text) {}
    private record Candidate(UUID id, String status, String reason, int attempts, String question, String answer,
                             UUID sourceId, String product, String edition) {}
    private record State(UUID id, String status) {}
    private record Match(String answer, UUID sourceId) {}
}
