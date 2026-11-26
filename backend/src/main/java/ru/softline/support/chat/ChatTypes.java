package ru.softline.support.chat;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

final class ChatTypes {
    record Send(UUID clientMessageId, String text, UUID retryOfTurnId) {}
    record Choose(String offerId, UUID catalogVersion) {}
    record Owner(UUID id, String token) {}
    record Message(UUID id, String role, String text, String status,
                   List<JsonNode> cards, List<JsonNode> sources, Instant createdAt) {}
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record PublicTurn(UUID turnId, String status, String outcome, String errorCode) {}
    record Session(UUID sessionId, List<Message> messages, JsonNode selectedOffer, PublicTurn lastTurn,
                   boolean quotesEnabled) {}
    record Turn(UUID turnId, UUID sessionId, UUID clientMessageId, String requestId, UUID userMessageId,
                UUID catalogVersion, String status, String outcome, Instant deadline, UUID retryOfTurnId,
                String code, boolean retryable, String userText) {
        PublicTurn publicView() {
            return new PublicTurn(turnId, status, outcome, code);
        }
    }
    record Accepted(Turn turn, boolean replay) {}
    record Done(UUID turnId, String outcome, Message message) {}
    record Fact(String id, String text) {}
    record Reply(String outcome, List<Fact> facts, List<JsonNode> cards, List<JsonNode> sources) {
        static Reply text(String outcome, String text) {
            return new Reply(outcome, List.of(new Fact("f1", text)), List.of(), List.of());
        }
    }

    private ChatTypes() {}
}
