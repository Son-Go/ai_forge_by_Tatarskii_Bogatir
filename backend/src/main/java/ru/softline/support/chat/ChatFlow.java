package ru.softline.support.chat;

import static ru.softline.support.chat.ChatTypes.*;

import com.fasterxml.jackson.databind.JsonNode;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import jakarta.annotation.PreDestroy;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.time.Duration;
import java.time.Instant;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.StreamSupport;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@Service
class ChatFlow {
    private static final Logger log = LoggerFactory.getLogger(ChatFlow.class);
    private final ChatStore store;
    private final MlClient ml;
    private final ReplyPlanner planner;
    private final Counter acceptedMessages;
    private final Semaphore capacity;
    private final long warmTimeoutMillis;
    private final long coldTimeoutMillis;
    private final long modelIdleNanos;
    private final AtomicLong lastModelResponse = new AtomicLong(Long.MIN_VALUE);
    private final java.util.concurrent.ScheduledExecutorService timers = Executors.newScheduledThreadPool(2);

    ChatFlow(ChatStore store, MlClient ml, ReplyPlanner planner, MeterRegistry metrics,
             @Value("${chat.parallel-turns:8}") int parallel,
             @Value("${chat.turn-timeout-ms}") long warmTimeoutMillis,
             @Value("${chat.cold-turn-timeout-ms}") long coldTimeoutMillis,
             @Value("${chat.model-idle-ms}") long modelIdleMillis) {
        if (parallel < 1 || warmTimeoutMillis < 100 || coldTimeoutMillis < warmTimeoutMillis
                || coldTimeoutMillis > 1_200_000 || modelIdleMillis < 1 || modelIdleMillis > 86_400_000) {
            throw new IllegalArgumentException("Invalid turn limits");
        }
        this.store = store;
        this.ml = ml;
        this.planner = planner;
        this.acceptedMessages = Counter.builder("chat.user.messages.accepted")
                .description("New user messages committed by the chat")
                .register(metrics);
        this.capacity = new Semaphore(parallel);
        this.warmTimeoutMillis = warmTimeoutMillis;
        this.coldTimeoutMillis = coldTimeoutMillis;
        this.modelIdleNanos = TimeUnit.MILLISECONDS.toNanos(modelIdleMillis);
    }

    SseEmitter open(UUID id, String token, Send input) {
        if (!capacity.tryAcquire()) throw new ChatError(429, "TURN_LIMIT", "Сервис занят. Повторите запрос чуть позже.");
        long startedNanos = System.nanoTime();
        long lastResponse = lastModelResponse.get();
        boolean cold = lastResponse == Long.MIN_VALUE || System.nanoTime() - lastResponse >= modelIdleNanos;
        long timeoutMillis = cold ? coldTimeoutMillis : warmTimeoutMillis;
        Accepted accepted;
        try {
            accepted = store.reserve(id, token, input, timeoutMillis);
        } catch (RuntimeException ex) {
            capacity.release();
            throw ex;
        }
        Turn turn = accepted.turn();
        // reserve has committed. Retries referencing a failed turn reuse its user message.
        if (!accepted.replay() && turn.retryOfTurnId() == null) acceptedMessages.increment();
        SseEmitter emitter = new SseEmitter(timeoutMillis + 8_000);
        AtomicBoolean finished = new AtomicBoolean();
        AtomicBoolean disconnected = new AtomicBoolean();
        Thread worker = Thread.ofVirtual().unstarted(() -> {
            TurnTiming timing = new TurnTiming(startedNanos);
            try {
                process(accepted, emitter, timing);
            } catch (IOException | UncheckedIOException ex) {
                disconnected.set(true);
            } catch (InterruptedException ex) {
                Thread.interrupted();
                String code = disconnected.get() ? "CLIENT_DISCONNECTED" : "TURN_TIMEOUT";
                timing.errorCode = code;
                if (!accepted.replay()) recordFailure(turn, code);
                if (!disconnected.get()) sendFailure(emitter, turn, code, true);
            } catch (RuntimeException ex) {
                boolean interrupted = Thread.interrupted();
                String code = disconnected.get() ? "CLIENT_DISCONNECTED"
                        : interrupted || !Instant.now().isBefore(turn.deadline()) ? "TURN_TIMEOUT"
                        : ex instanceof ChatError error ? error.code : "TURN_FAILED";
                timing.errorCode = code;
                log.warn("Chat turn failure request_id={} turn_id={} code={}", turn.requestId(), turn.turnId(), code);
                if (!accepted.replay()) recordFailure(turn, code);
                if (!disconnected.get()) sendFailure(emitter, turn, code, true);
            } finally {
                try {
                    if (disconnected.get() && !accepted.replay()) {
                        timing.errorCode = "CLIENT_DISCONNECTED";
                        recordFailure(turn, timing.errorCode);
                    }
                } finally {
                    finished.set(true);
                    capacity.release();
                    if (!accepted.replay()) timing.writeLog(turn, cold, timeoutMillis);
                    emitter.complete();
                }
            }
        });
        Runnable cancel = () -> {
            if (!finished.get()) {
                disconnected.set(true);
                worker.interrupt();
            }
        };
        var heartbeat = timers.scheduleAtFixedRate(() -> {
            if (!finished.get()) {
                try { emitter.send(SseEmitter.event().comment("waiting")); }
                catch (IOException | IllegalStateException ex) { cancel.run(); }
            }
        }, 8, 8, TimeUnit.SECONDS);
        long remaining = accepted.replay() ? 5_000 : Math.max(1, Duration.between(Instant.now(), turn.deadline()).toMillis());
        var timeout = timers.schedule(worker::interrupt, remaining, TimeUnit.MILLISECONDS);
        emitter.onCompletion(() -> {
            heartbeat.cancel(false);
            timeout.cancel(false);
            cancel.run();
        });
        emitter.onError(error -> cancel.run());
        emitter.onTimeout(cancel);
        worker.start();
        return emitter;
    }

    private void process(Accepted accepted, SseEmitter emitter, TurnTiming timing) throws IOException, InterruptedException {
        Turn turn = accepted.turn();
        send(emitter, "accepted", Map.of("turn_id", turn.turnId(), "client_message_id", turn.clientMessageId(),
                "user_message_id", turn.userMessageId(), "request_id", turn.requestId()));
        if (accepted.replay()) {
            if ("complete".equals(turn.status())) send(emitter, "done", store.savedAnswer(turn));
            else sendFailure(emitter, turn, turn.code(), turn.retryable());
            return;
        }
        Map<String, Object> old = store.requirements(turn);
        String activeHandoff = store.activeHandoffReason(turn.sessionId());
        String supportTopic = store.supportTopic(turn.sessionId());
        Reply direct = activeHandoff == null ? planner.explicitHandoff(turn.userText(), old)
                : Reply.handoff(activeHandoff, "Сообщение добавлено к обращению. Менеджер увидит его в этом диалоге.");
        if (direct == null) direct = planner.commercialSupport(turn.userText(), supportTopic, null);
        if (direct == null) direct = store.directPricingReply(turn);
        if (direct == null) direct = planner.commercialGuide(turn.userText());
        if (direct != null) {
            finishDirect(turn, emitter, timing, old, direct);
            return;
        }
        send(emitter, "status", Map.of("stage", "interpreting"));
        List<Map<String, String>> context = store.context(turn);
        MlClient.Interpretation interpretation;
        try {
            long interpretationStarted = System.nanoTime();
            try {
                interpretation = ml.interpret(turn, old, context);
            } finally {
                timing.interpretMs = elapsedMillis(interpretationStarted);
            }
            lastModelResponse.accumulateAndGet(System.nanoTime(), Math::max);
        } catch (IOException ex) {
            requireActive(turn);
            String code = ex instanceof java.net.http.HttpTimeoutException ? "TURN_TIMEOUT" : "ML_UNAVAILABLE";
            timing.errorCode = code;
            recordFailure(turn, code);
            sendFailure(emitter, turn, code, true);
            return;
        }
        Reply support = planner.commercialSupport(turn.userText(), supportTopic, interpretation);
        if (support == null) support = store.pricingReply(turn, interpretation);
        if (support != null) {
            finishDirect(turn, emitter, timing, old, support);
            return;
        }
        long searchStarted = System.nanoTime();
        Map<String, Object> saved;
        Reply reply;
        try {
            send(emitter, "status", Map.of("stage", "searching"));
            if (planner.isProductQuestion(turn.userText(), interpretation)) {
                saved = old;
                reply = planner.question(turn, interpretation, old);
            } else {
                saved = planner.apply(old, interpretation, turn.userText());
                reply = planner.plan(turn, interpretation, saved);
            }
        } finally {
            timing.searchMs = elapsedMillis(searchStarted);
        }
        Set<String> sent = new HashSet<>();
        String promptVersion = null;
        // Only answers that combine several excerpts need model composition.
        if ("answer".equals(reply.outcome()) && reply.cards().isEmpty() && reply.facts().size() > 1
                && reply.sources().size() > 1) {
            send(emitter, "status", Map.of("stage", "generating"));
            try {
                long compositionStarted = System.nanoTime();
                try {
                    promptVersion = ml.compose(turn, reply,
                            block -> emitFactBlock(turn, emitter, reply.facts(), block, sent, timing));
                } finally {
                    timing.composeMs = elapsedMillis(compositionStarted);
                }
                lastModelResponse.accumulateAndGet(System.nanoTime(), Math::max);
            } catch (IOException ex) {
                requireActive(turn);
                timing.composeFallback = true;
                log.info("Using verified facts request_id={} turn_id={}", turn.requestId(), turn.turnId());
            }
        }
        requireActive(turn);
        if (reply.handoffReason() == null) {
            for (Fact fact : reply.facts()) {
                if (sent.add(fact.id())) append(turn, emitter, fact.text(), sent.size() > 1, timing);
            }
        }
        Done answer = store.complete(turn, reply, saved, !old.equals(saved), validVersion(interpretation.modelVersion()),
                validVersion(promptVersion));
        send(emitter, "done", answer);
        timing.outcome = answer.outcome();
    }

    private void finishDirect(Turn turn, SseEmitter emitter, TurnTiming timing, Map<String, Object> requirements,
                              Reply reply) throws IOException {
        if (reply.handoffReason() == null) append(turn, emitter, reply.facts().getFirst().text(), false, timing);
        Done answer = store.complete(turn, reply, requirements, false, null, null);
        send(emitter, "done", answer);
        timing.outcome = answer.outcome();
    }

    private void emitFactBlock(Turn turn, SseEmitter emitter, List<Fact> facts, JsonNode block, Set<String> sent,
                               TurnTiming timing) {
        JsonNode ids = block.path("fact_ids");
        if (!ids.isArray() || ids.isEmpty()) return;
        var listed = StreamSupport.stream(ids.spliterator(), false)
                .filter(JsonNode::isTextual).map(JsonNode::asText).toList();
        if (listed.size() != ids.size() || listed.stream().distinct().count() != listed.size()) return;
        var matched = listed.stream().map(id -> facts.stream().filter(f -> f.id().equals(id)).findFirst()).toList();
        if (matched.stream().anyMatch(java.util.Optional::isEmpty)) return;
        // Only verified source text goes to the browser. ML can order fact blocks without adding new claims.
        for (var item : matched) {
            Fact fact = item.orElseThrow();
            if (sent.add(fact.id())) {
                try { append(turn, emitter, fact.text(), sent.size() > 1, timing); }
                catch (IOException ex) { throw new UncheckedIOException(ex); }
            }
        }
    }

    private void append(Turn turn, SseEmitter emitter, String text, boolean subsequent, TurnTiming timing) throws IOException {
        String content = subsequent ? "\n\n" + text : text;
        int seq = store.append(turn, content);
        send(emitter, "delta", Map.of("seq", seq, "text", content));
        if (timing.firstDeltaMs == null) timing.firstDeltaMs = elapsedMillis(timing.startedNanos);
    }

    private static long elapsedMillis(long since) {
        return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - since);
    }

    private static final class TurnTiming {
        private final long startedNanos;
        private Long interpretMs;
        private Long searchMs;
        private Long composeMs;
        private Long firstDeltaMs;
        private boolean composeFallback;
        private String outcome;
        private String errorCode;

        TurnTiming(long startedNanos) {
            this.startedNanos = startedNanos;
        }

        void writeLog(Turn turn, boolean cold, long budgetMillis) {
            log.info("Chat turn timing request_id={} turn_id={} budget={} budget_ms={} interpret_ms={} search_ms={} "
                            + "compose_ms={} first_delta_ms={} total_ms={} compose_fallback={} outcome={} error_code={}",
                    turn.requestId(), turn.turnId(), cold ? "cold" : "warm", budgetMillis, interpretMs, searchMs,
                    composeMs, firstDeltaMs, elapsedMillis(startedNanos), composeFallback, outcome, errorCode);
        }
    }

    private static String validVersion(String name) {
        return name != null && name.matches("[A-Za-z0-9_.:/-]{1,120}") ? name : null;
    }

    private static void requireActive(Turn turn) throws InterruptedException {
        if (Thread.interrupted() || !Instant.now().isBefore(turn.deadline())) throw new InterruptedException();
    }

    private void recordFailure(Turn turn, String code) {
        Thread.interrupted();
        try {
            store.fail(turn, code, true);
        } catch (RuntimeException ex) {
            log.warn("Failed to persist terminal state request_id={} turn_id={} code={}",
                    turn.requestId(), turn.turnId(), code);
        }
    }

    private static void sendFailure(SseEmitter emitter, Turn turn, String code, boolean retryable) {
        try {
            String message = "TURN_TIMEOUT".equals(code)
                    ? "Истекло время ожидания модели. Можно повторить запрос."
                    : "Не удалось завершить ответ. Можно повторить запрос.";
            send(emitter, "failed", Map.of("turn_id", turn.turnId(), "code", code,
                    "message", message, "retryable", retryable));
        } catch (IOException | IllegalStateException ex) {
            log.debug("SSE disconnected request_id={}", turn.requestId());
        }
    }

    private static void send(SseEmitter emitter, String event, Object value) throws IOException {
        emitter.send(SseEmitter.event().name(event).data(value, org.springframework.http.MediaType.APPLICATION_JSON));
    }

    @PreDestroy
    void stopTimers() { timers.shutdownNow(); }
}
