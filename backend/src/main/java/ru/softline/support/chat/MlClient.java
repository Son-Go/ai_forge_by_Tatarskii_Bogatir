package ru.softline.support.chat;

import static ru.softline.support.chat.ChatTypes.*;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
class MlClient {
    private static final int MAX_JSON = 131_072;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(4))
            .followRedirects(HttpClient.Redirect.NEVER).build();
    private final ObjectMapper json;
    private final URI base;
    private final String token;

    MlClient(ObjectMapper json, @Value("${ml.base-url:}") String url,
             @Value("${ml.service-token:}") String token, @Value("${ml.data-region:}") String region) {
        this.json = json;
        this.token = token;
        this.base = url.isBlank() ? null : URI.create(url);
        if (base != null && (!"RU".equals(region) || token.isBlank() || base.getHost() == null
                || !List.of("http", "https").contains(base.getScheme()) || base.getUserInfo() != null)) {
            throw new IllegalArgumentException("ML requires a Russian deployment, an HTTP service address and a service token");
        }
    }

    Interpretation interpret(Turn turn, Map<String, Object> requirements, List<Map<String, String>> context)
            throws IOException, InterruptedException {
        var response = call(turn, "/internal/v1/interpret", "application/json",
                Map.of("text", turn.userText(), "conversation_context", context, "requirements", requirements));
        try (InputStream input = response.body()) {
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
                Map.of("outcome", reply.outcome(), "facts", reply.facts(), "language", "ru"));
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

    private HttpResponse<InputStream> call(Turn turn, String path, String accept, Map<String, ?> fields)
            throws IOException, InterruptedException {
        if (base == null) throw new IOException("ML endpoint not configured");
        long remaining = Duration.between(Instant.now(), turn.deadline()).toMillis();
        if (remaining <= 0) throw new java.net.http.HttpTimeoutException("Turn deadline expired");
        var body = json.valueToTree(fields);
        if (!(body instanceof com.fasterxml.jackson.databind.node.ObjectNode object)) {
            throw new JsonProcessingException("ML request must be an object") {};
        }
        object.put("request_id", turn.requestId()).put("deadline_ms", remaining);
        var request = HttpRequest.newBuilder(base.resolve(path))
                .timeout(Duration.ofMillis(remaining)).header("Authorization", "Bearer " + token)
                .header("Accept", accept).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofByteArray(json.writeValueAsBytes(object))).build();
        return http.send(request, HttpResponse.BodyHandlers.ofInputStream());
    }

    private static void verify(HttpResponse<?> response, String type) throws IOException {
        if (response.statusCode() != 200 || response.headers().firstValue("Content-Type")
                .filter(value -> value.toLowerCase(java.util.Locale.ROOT).startsWith(type)).isEmpty()) {
            throw new IOException("Invalid ML HTTP response");
        }
    }

    record Interpretation(String intent, String productQuery, List<Update> updates,
                          List<String> clarificationCandidates, String modelVersion) {}
    record Update(String op, String field, JsonNode value, String evidence) {}
}
