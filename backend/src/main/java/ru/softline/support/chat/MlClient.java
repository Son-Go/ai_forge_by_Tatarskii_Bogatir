package ru.softline.support.chat;

import static ru.softline.support.chat.ChatTypes.*;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Consumer;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
class MlClient {
    private static final int MAX_JSON = 131_072;
    private final HttpClient http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1)
            .connectTimeout(Duration.ofSeconds(4))
            .followRedirects(HttpClient.Redirect.NEVER).build();
    private final ObjectMapper json;
    private final URI base;
    private final String token;
    private final int maxContextBytes;

    MlClient(ObjectMapper json, @Value("${ml.base-url:}") String url,
             @Value("${ml.service-token:}") String token, @Value("${ml.data-region:}") String region,
             @Value("${ml.data-scope:}") String dataScope,
             @Value("${ml.max-context-bytes:24000}") int maxContextBytes) {
        this.json = json;
        this.token = token;
        this.base = url.isBlank() ? null : URI.create(url);
        if (maxContextBytes < 4_000 || maxContextBytes > 100_000) {
            throw new IllegalArgumentException("ML context budget must be between 4000 and 100000 bytes");
        }
        this.maxContextBytes = maxContextBytes;
        boolean supportedRegion = "RU".equals(region) || ("NL".equals(region) && "public-synthetic".equals(dataScope));
        if (base != null && (!supportedRegion || token.isBlank() || base.getHost() == null
                || !List.of("http", "https").contains(base.getScheme()) || base.getUserInfo() != null)) {
            throw new IllegalArgumentException(
                    "ML requires region RU or NL with public-synthetic data scope, an HTTP service address and a service token");
        }
    }

    Interpretation interpret(Turn turn, Map<String, Object> requirements, List<Map<String, String>> context)
            throws IOException, InterruptedException {
        var response = call(turn, "/internal/v1/interpret", "application/json",
                Map.of("text", turn.userText(), "conversation_context", context, "requirements", requirements));
        try (InputStream input = response.body()) {
            if (response.statusCode() == 503 && isModelTimeout(input)) {
                throw new HttpTimeoutException("ML model deadline expired");
            }
            verify(response, "application/json");
            byte[] data = input.readNBytes(MAX_JSON + 1);
            if (data.length > MAX_JSON) throw new IOException("Invalid ML body size");
            var result = json.readValue(data, Interpretation.class);
            if (result.intent() == null || !List.of("known_product", "needs_solution", "product_question").contains(result.intent())
                    || result.updates() == null || result.clarificationCandidates() == null) {
                throw new IOException("Invalid ML interpretation");
            }
            return result;
        }
    }

    String compose(Turn turn, Reply reply, Consumer<JsonNode> block) throws IOException, InterruptedException {
        var response = call(turn, "/internal/v1/compose", "text/event-stream",
                Map.of("outcome", reply.outcome(), "facts", reply.facts().stream()
                        .map(fact -> new Fact(fact.id(), limitFactText(fact.text()))).toList(), "language", "ru"));
        try (InputStream input = response.body();
             BufferedReader lines = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            verify(response, "text/event-stream");
            String event = "";
            StringBuilder data = new StringBuilder();
            String line;
            while ((line = lines.readLine()) != null) {
                if (Thread.currentThread().isInterrupted()) throw new InterruptedException();
                if (line.isEmpty()) {
                    if (!data.isEmpty()) {
                        JsonNode payload = json.readTree(data.toString());
                        switch (event) {
                            case "block" -> block.accept(payload);
                            case "complete" -> { return payload.path("prompt_version").asText(null); }
                            case "failed" -> throw new IOException("ML reported a failure");
                            default -> throw new IOException("Unknown ML stream event");
                        }
                    }
                    event = "";
                    data.setLength(0);
                } else if (line.startsWith("event:")) {
                    event = line.substring(6).strip();
                } else if (line.startsWith("data:")) {
                    if (!data.isEmpty()) data.append('\n');
                    data.append(line.substring(5).stripLeading());
                    if (data.length() > MAX_JSON) throw new IOException("Invalid ML event size");
                }
            }
            throw new IOException("Incomplete ML stream");
        }
    }

    FaqReview reviewFaq(UUID candidate, String question, String answer, List<FaqExcerpt> sources, int deadlineMs)
            throws IOException, InterruptedException {
        if (base == null) throw new IOException("ML endpoint not configured");
        var request = HttpRequest.newBuilder(base.resolve("/internal/v1/faq/review"))
                .timeout(Duration.ofMillis(deadlineMs)).header("Authorization", "Bearer " + token)
                .header("Accept", "application/json").header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofByteArray(boundedPayload(json.valueToTree(Map.of(
                        "request_id", UUID.randomUUID(), "candidate_id", candidate, "deadline_ms", deadlineMs,
                        "question", question, "answer", answer, "sources", sources))))).build();
        var pending = http.sendAsync(request, ignored -> new BoundedJson());
        HttpResponse<byte[]> response;
        try {
            response = pending.get(deadlineMs, TimeUnit.MILLISECONDS);
        } catch (TimeoutException ex) {
            throw new HttpTimeoutException("FAQ review deadline expired");
        } catch (ExecutionException ex) {
            throw new IOException("FAQ review call failed", ex);
        } finally {
            pending.cancel(true);
        }
        verify(response, "application/json");
        JsonNode result = json.readTree(response.body());
        Set<String> keys = Set.of("verdict", "reason_code", "question", "answer", "source_ids",
                "prompt_version", "model_version");
        if (result == null || !result.isObject() || result.size() != keys.size()
                || keys.stream().anyMatch(key -> !result.has(key))
                || !boundedText(result.get("question"), 500, true)
                || !boundedText(result.get("answer"), 2000, true)
                || !result.path("source_ids").isArray() || result.path("source_ids").size() > 3
                || !boundedText(result.get("prompt_version"), 128, false)
                || !boundedText(result.get("model_version"), 128, false)) {
            throw new IOException("Invalid FAQ review result");
        }
        try {
            FaqReview review = json.treeToValue(result, FaqReview.class);
            if (!List.of("publish", "needs_review", "case_specific").contains(result.path("verdict").asText())
                    || !List.of("supported", "insufficient_evidence", "incomplete_answer", "case_specific",
                            "unsafe_content").contains(result.path("reason_code").asText())
                    || review.sourceIds().stream().anyMatch(java.util.Objects::isNull)
                    || review.sourceIds().stream().distinct().count() != review.sourceIds().size()
                    || "publish".equals(review.verdict()) && (!"supported".equals(review.reasonCode())
                        || review.sourceIds().isEmpty() || !boundedText(result.get("question"), 500, false)
                        || !boundedText(result.get("answer"), 2000, false))) {
                throw new IOException("Invalid FAQ review result");
            }
            return review;
        } catch (IllegalArgumentException ex) {
            throw new IOException("Invalid FAQ review result", ex);
        }
    }

    private static boolean boundedText(JsonNode value, int max, boolean nullable) {
        return nullable && value.isNull() || value.isTextual() && value.textValue().length() <= max
                && (nullable || !value.textValue().isBlank());
    }

    private static final class BoundedJson implements HttpResponse.BodySubscriber<byte[]> {
        private final CompletableFuture<byte[]> result = new CompletableFuture<>();
        private final ByteArrayOutputStream body = new ByteArrayOutputStream();
        private Flow.Subscription subscription;

        @Override public CompletableFuture<byte[]> getBody() { return result; }

        @Override public void onSubscribe(Flow.Subscription value) {
            subscription = value;
            value.request(1);
        }

        @Override public void onNext(List<ByteBuffer> data) {
            for (ByteBuffer buffer : data) {
                if (buffer.remaining() > MAX_JSON - body.size()) {
                    subscription.cancel();
                    result.completeExceptionally(new IOException("Invalid ML body size"));
                    return;
                }
                byte[] bytes = new byte[buffer.remaining()];
                buffer.get(bytes);
                body.writeBytes(bytes);
            }
            subscription.request(1);
        }

        @Override public void onError(Throwable error) { result.completeExceptionally(error); }

        @Override public void onComplete() { result.complete(body.toByteArray()); }
    }

    private HttpResponse<InputStream> call(Turn turn, String path, String accept, Map<String, ?> fields)
            throws IOException, InterruptedException {
        if (base == null) throw new IOException("ML endpoint not configured");
        long remaining = Duration.between(Instant.now(), turn.deadline()).toMillis();
        if (remaining <= 0) throw new java.net.http.HttpTimeoutException("Turn deadline expired");
        var body = json.valueToTree(fields);
        if (!(body instanceof ObjectNode object)) {
            throw new JsonProcessingException("ML request must be an object") {};
        }
        object.put("request_id", turn.requestId()).put("deadline_ms", remaining);
        byte[] payload = boundedPayload(object);
        var request = HttpRequest.newBuilder(base.resolve(path))
                .timeout(Duration.ofMillis(remaining)).header("Authorization", "Bearer " + token)
                .header("Accept", accept).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofByteArray(payload)).build();
        return http.send(request, HttpResponse.BodyHandlers.ofInputStream());
    }

    private byte[] boundedPayload(ObjectNode body) throws IOException {
        byte[] payload = json.writeValueAsBytes(body);
        if (body.get("conversation_context") instanceof ArrayNode history) {
            while (payload.length > maxContextBytes && !history.isEmpty()) {
                history.remove(0);
                payload = json.writeValueAsBytes(body);
            }
        } else if (body.get("facts") instanceof ArrayNode facts) {
            while (payload.length > maxContextBytes && facts.size() > 1) {
                facts.remove(facts.size() - 1);
                payload = json.writeValueAsBytes(body);
            }
        }
        if (payload.length > maxContextBytes) throw new IOException("ML context budget exceeded");
        return payload;
    }

    private static String limitFactText(String text) {
        return text.codePointCount(0, text.length()) > 2_000
                ? text.substring(0, text.offsetByCodePoints(0, 2_000))
                : text;
    }

    private static void verify(HttpResponse<?> response, String type) throws IOException {
        if (response.statusCode() != 200 || response.headers().firstValue("Content-Type")
                .filter(value -> value.toLowerCase(java.util.Locale.ROOT).startsWith(type)).isEmpty()) {
            throw new IOException("Invalid ML HTTP response");
        }
    }

    private boolean isModelTimeout(InputStream input) throws IOException {
        byte[] data = input.readNBytes(MAX_JSON + 1);
        if (data.length > MAX_JSON) return false;
        try {
            JsonNode error = json.readTree(data);
            return error != null && "MODEL_TIMEOUT".equals(error.path("code").asText());
        } catch (JsonProcessingException ignored) {
            return false;
        }
    }

    record Interpretation(String intent, String productQuery, List<Update> updates,
                          List<String> clarificationCandidates, String modelVersion, List<Signal> signals) {}
    record Signal(String kind, String evidence) {}
    record Update(String op, String field, JsonNode value, String evidence) {}
    record FaqExcerpt(UUID id, String text) {}
    record FaqReview(String verdict, String reasonCode, String question, String answer, List<UUID> sourceIds,
                     String promptVersion, String modelVersion) {}
}
