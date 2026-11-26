package ru.softline.support.chat;

import static ru.softline.support.chat.ChatTypes.*;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.net.URI;
import java.time.Duration;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.CookieValue;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@RestController
@RequestMapping("/api/v1/sessions")
class ChatController {
    private static final String COOKIE = "softline_session";
    private final ChatStore store;
    private final ChatFlow flow;
    private final DocumentDraftPdf draftPdf;
    private final Set<String> origins;
    private final RateWindow rate = new RateWindow();

    ChatController(ChatStore store, ChatFlow flow, DocumentDraftPdf draftPdf,
                   @Value("${chat.public-origin:http://localhost:8080}") String publicOrigins) {
        this.store = store;
        this.flow = flow;
        this.draftPdf = draftPdf;
        this.origins = Set.copyOf(Arrays.stream(publicOrigins.split(",", -1))
                .map(String::strip).map(ChatController::validatedOrigin).toList());
    }

    private static String validatedOrigin(String origin) {
        URI address = URI.create(origin);
        String scheme = address.getScheme();
        if (scheme == null || !Set.of("http", "https").contains(scheme) || address.getHost() == null
                || address.getUserInfo() != null || !address.getRawPath().isEmpty()
                || address.getRawQuery() != null || address.getRawFragment() != null) {
            throw new IllegalArgumentException("chat.public-origin must list HTTP(S) origins without paths");
        }
        return origin;
    }

    @PostMapping
    ResponseEntity<Map<String, UUID>> create(HttpServletRequest request,
                                           @CookieValue(value = COOKIE, required = false) String token) {
        requireOrigin(request);
        rate.take("create:" + request.getRemoteAddr(), 20);
        Owner owner = store.create(token);
        String cookie = ResponseCookie.from(COOKIE, owner.token()).httpOnly(true).secure(true)
                .sameSite("Lax").path("/api/v1/sessions").build().toString();
        return ResponseEntity.created(URI.create("/api/v1/sessions/" + owner.id()))
                .header(HttpHeaders.SET_COOKIE, cookie).body(Map.of("session_id", owner.id()));
    }

    @GetMapping("/{id}")
    ResponseEntity<Session> read(@PathVariable UUID id, @CookieValue(value = COOKIE, required = false) String token) {
        return ResponseEntity.ok().header(HttpHeaders.CACHE_CONTROL, "no-store").body(store.read(id, token));
    }

    @GetMapping("/{id}/handoff")
    ResponseEntity<HandoffStatus> handoffStatus(@PathVariable UUID id,
                                               @CookieValue(value = COOKIE, required = false) String token) {
        return ResponseEntity.ok().header(HttpHeaders.CACHE_CONTROL, "no-store").body(store.handoffStatus(id, token));
    }

    @PostMapping(value = "/{id}/messages", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    ResponseEntity<SseEmitter> message(@PathVariable UUID id, @RequestBody Send send, HttpServletRequest request,
                                       @CookieValue(value = COOKIE, required = false) String token) {
        requireOrigin(request);
        if (send.clientMessageId() == null || send.text() == null || send.text().isBlank()
                || send.text().length() > 4_000) throw ChatErrors.invalid();
        rate.take("message:" + request.getRemoteAddr(), 90);
        rate.take("session:" + id, 30);
        return ResponseEntity.ok().header(HttpHeaders.CACHE_CONTROL, "no-store")
                .body(flow.open(id, token, send));
    }

    @PostMapping("/{id}/selection")
    JsonNode select(@PathVariable UUID id, @RequestBody Choose selection, HttpServletRequest request,
                    @CookieValue(value = COOKIE, required = false) String token) {
        requireOrigin(request);
        if (selection.catalogVersion() == null || selection.offerId() == null || selection.offerId().isBlank()
                || selection.offerId().length() > 256) throw ChatErrors.invalid();
        rate.take("session:" + id, 30);
        return store.select(id, token, selection);
    }

    @PostMapping("/{id}/quote-drafts")
    ResponseEntity<byte[]> quote(@PathVariable UUID id, @RequestBody(required = false) DocumentDraftRequest input,
                                 HttpServletRequest request,
                                 @CookieValue(value = COOKIE, required = false) String token) throws IOException {
        return draft(id, input, request, token, DraftKind.QUOTE);
    }

    @PostMapping("/{id}/invoice-drafts")
    ResponseEntity<byte[]> invoiceDraft(@PathVariable UUID id, @RequestBody(required = false) DocumentDraftRequest input,
                                        HttpServletRequest request,
                                        @CookieValue(value = COOKIE, required = false) String token) throws IOException {
        return draft(id, input, request, token, DraftKind.INVOICE);
    }

    private ResponseEntity<byte[]> draft(UUID id, DocumentDraftRequest input, HttpServletRequest request,
                                         String token, DraftKind kind) throws IOException {
        requireOrigin(request);
        rate.take("session:" + id, 30);
        byte[] pdf = draftPdf.render(store.prepareDraft(id, token, input, kind), kind);
        return ResponseEntity.ok().contentType(MediaType.APPLICATION_PDF)
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=" + kind.fileName)
                .header(HttpHeaders.CACHE_CONTROL, "no-store").body(pdf);
    }

    private void requireOrigin(HttpServletRequest request) {
        String origin = request.getHeader(HttpHeaders.ORIGIN);
        if (origin == null || !origins.contains(origin)) {
            throw new ChatError(403, "INVALID_ORIGIN", "Источник запроса не разрешён.");
        }
    }

    private static final class RateWindow {
        private final Map<String, Integer> counts = new HashMap<>();
        private long start = System.nanoTime();

        synchronized void take(String key, int limit) {
            long now = System.nanoTime();
            if (now - start >= Duration.ofMinutes(1).toNanos()) {
                start = now;
                counts.clear();
            }
            if ((counts.size() >= 100_000 && !counts.containsKey(key))
                    || counts.getOrDefault(key, 0) >= limit) {
                throw new ChatError(429, "RATE_LIMIT", "Превышено число запросов. Повторите через минуту.");
            }
            counts.merge(key, 1, Integer::sum);
        }
    }
}
