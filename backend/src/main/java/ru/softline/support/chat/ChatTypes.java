package ru.softline.support.chat;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

final class ChatTypes {
    record Send(UUID clientMessageId, String text, UUID retryOfTurnId) {}
    record Choose(String offerId, UUID catalogVersion) {}
    record DocumentDraftRequest(String customerName, BigDecimal quantity) {}
    record DocumentDraft(String customerName, String name, String vendorCode, int quantity,
                         BigDecimal unitPrice, String currency) {
        BigDecimal total() {
            return unitPrice.multiply(BigDecimal.valueOf(quantity));
        }
    }
    enum DraftKind {
        QUOTE("Коммерческое предложение", "quote-draft.pdf", "НДС, условия оплаты, срок поставки и срок действия уточняет менеджер."),
        INVOICE("Счёт", "invoice-draft.pdf", "Черновик для согласования. Оплата по документу не предусмотрена.");

        final String title;
        final String fileName;
        final String note;

        DraftKind(String title, String fileName, String note) {
            this.title = title;
            this.fileName = fileName;
            this.note = note;
        }

        String errorCode(String suffix) {
            return name() + "_" + suffix;
        }
    }
    record Owner(UUID id, String token) {}
    record Message(UUID id, String role, String text, String status,
                   List<JsonNode> cards, List<JsonNode> sources, Instant createdAt,
                   @JsonInclude(JsonInclude.Include.NON_NULL) String sender) {}
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
    record Handoff(UUID handoffId, String reason, String status, Instant createdAt) {}
    record QueueItem(UUID handoffId, UUID sessionId, String reason, String status, Instant createdAt) {}
    record AssignedHandoff(QueueItem handoff, List<Message> messages) {}
    record HandoffStatus(Handoff handoff) {}
    record ManagerMessage(UUID messageId, String text) {}
    record Fact(String id, String text) {}
    record Reply(String outcome, List<Fact> facts, List<JsonNode> cards, List<JsonNode> sources, String handoffReason) {
        Reply(String outcome, List<Fact> facts, List<JsonNode> cards, List<JsonNode> sources) {
            this(outcome, facts, cards, sources, null);
        }

        static Reply text(String outcome, String text) {
            return new Reply(outcome, List.of(new Fact("f1", text)), List.of(), List.of());
        }

        static Reply handoff(String reason, String text) {
            return new Reply("insufficient_data", List.of(new Fact("f1", text)), List.of(), List.of(), reason);
        }
    }

    private ChatTypes() {}
}
