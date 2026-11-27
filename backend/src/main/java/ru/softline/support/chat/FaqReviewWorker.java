package ru.softline.support.chat;

import java.io.IOException;
import java.text.BreakIterator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import ru.softline.support.catalog.CatalogSearch;
import ru.softline.support.chat.FaqStore.FaqApproval;
import ru.softline.support.chat.FaqStore.Job;
import ru.softline.support.chat.MlClient.FaqExcerpt;

@Component
@ConditionalOnProperty(name = "faq.review-enabled", havingValue = "true")
class FaqReviewWorker {
    private static final Logger log = LoggerFactory.getLogger(FaqReviewWorker.class);
    private static final int BATCH_SIZE = 3;
    private final FaqStore store;
    private final CatalogSearch catalog;
    private final MlClient ml;
    private final int deadlineMs;

    FaqReviewWorker(FaqStore store, CatalogSearch catalog, MlClient ml,
                    @Value("${faq.review-timeout-ms:30000}") int deadlineMs) {
        if (deadlineMs < 100 || deadlineMs > 120_000) throw new IllegalArgumentException("Invalid FAQ review timeout");
        this.store = store;
        this.catalog = catalog;
        this.ml = ml;
        this.deadlineMs = deadlineMs;
    }

    @Scheduled(fixedDelayString = "${faq.poll-ms:5000}")
    void poll() {
        for (int i = 0; i < BATCH_SIZE; i++) {
            Job job = store.claim(deadlineMs + 30_000);
            if (job == null) return;
            try {
                review(job);
            } catch (InterruptedException ex) {
                store.retry(job);
                Thread.currentThread().interrupt();
                return;
            } catch (IOException ex) {
                store.retry(job);
                log.info("FAQ review deferred candidate_id={}", job.id());
            }
        }
    }

    private void review(Job job) throws IOException, InterruptedException {
        if (FaqText.caseSpecific(job.question()) || FaqText.caseSpecific(job.answer())) {
            store.finish(job, "case_specific", "case_specific", null, null);
            return;
        }
        if (FaqText.privateData(job.question()) || FaqText.privateData(job.answer())
                || FaqText.dynamic(job.question()) || FaqText.dynamic(job.answer())
                || job.question().length() > 500 || job.answer().length() > 2000) {
            store.finish(job, "needs_review", "unsafe_content", null, null);
            return;
        }

        List<FaqExcerpt> excerpts = catalog.faqKnowledge(FaqText.key(job.question())).stream()
                .map(source -> new FaqExcerpt(source.id(), FaqText.clip(source.text().strip(), 1500)))
                .filter(source -> !source.text().isBlank() && !FaqText.privateData(source.text())).toList();
        if (excerpts.isEmpty()) {
            store.finish(job, "needs_review", "insufficient_evidence", null, null);
            return;
        }
        var trusted = FaqText.trustedWords(excerpts.stream().map(FaqExcerpt::text).toList());
        String question = FaqText.forReview(job.question(), trusted);
        String answer = FaqText.forReview(job.answer(), trusted);
        if (question.length() > 500 || answer.length() > 2000
                || FaqText.key(question.replace("[скрыто]", "")).isEmpty()
                || FaqText.key(answer.replace("[скрыто]", "")).isEmpty()) {
            store.finish(job, "needs_review", "insufficient_evidence", null, null);
            return;
        }
        var result = ml.reviewFaq(job.id(), question, answer, excerpts, deadlineMs);
        if ("case_specific".equals(result.verdict())) {
            store.finish(job, "case_specific", result.reasonCode(), null, result);
            return;
        }

        var proposedSource = excerpts.stream().filter(s -> result.sourceIds().contains(s.id())).findFirst().orElse(null);
        var proposal = canSuggest(result.question(), result.answer(), trusted)
                ? new FaqApproval(result.question().strip(), result.answer().strip(),
                        proposedSource == null ? null : proposedSource.id(), null, null)
                : null;
        String reason = result.reasonCode();
        if ("publish".equals(result.verdict())) {
            boolean validIds = result.sourceIds().stream().allMatch(id -> excerpts.stream().anyMatch(s -> s.id().equals(id)));
            if (proposal != null && validIds && !question.contains("[скрыто]") && !answer.contains("[скрыто]")
                    && store.equivalent(question, proposal.question())) {
                var supporting = excerpts.stream().filter(s -> result.sourceIds().contains(s.id())
                        && wholeSentence(s.text(), proposal.answer())).findFirst();
                if (supporting.isPresent()) {
                    store.finish(job, "published", reason, new FaqApproval(proposal.question(), proposal.answer(),
                            supporting.get().id(), null, null), result);
                    return;
                }
            }
            reason = "insufficient_evidence";
        }
        store.finish(job, "needs_review", reason, proposal, result);
    }

    private static boolean canSuggest(String question, String answer, Set<String> trusted) {
        return question != null && answer != null && !FaqText.key(question).isEmpty() && !FaqText.key(answer).isEmpty()
                && !FaqText.privateData(question) && !FaqText.privateData(answer)
                && !FaqText.dynamic(question) && !FaqText.dynamic(answer)
                && !FaqText.caseSpecific(question) && !FaqText.caseSpecific(answer)
                && !FaqText.forReview(question, trusted).contains("[скрыто]")
                && !FaqText.forReview(answer, trusted).contains("[скрыто]");
    }

    private static boolean wholeSentence(String excerpt, String answer) {
        if (!answer.matches("(?s).*[.!?]$")) return false;
        BreakIterator sentences = BreakIterator.getSentenceInstance(Locale.forLanguageTag("ru"));
        sentences.setText(excerpt);
        for (int start = sentences.first(), end = sentences.next(); end != BreakIterator.DONE;
                start = end, end = sentences.next()) {
            if (excerpt.substring(start, end).strip().equals(answer)) return true;
        }
        return false;
    }
}
