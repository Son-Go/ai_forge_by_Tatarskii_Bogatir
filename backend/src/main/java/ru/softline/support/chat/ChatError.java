package ru.softline.support.chat;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.UUID;

final class ChatError extends RuntimeException {
    final int status;
    final String code;
    final UUID turnId;
    final JsonNode updatedOffer;

    ChatError(int status, String code, String message) {
        this(status, code, message, null, null);
    }

    ChatError(int status, String code, String message, UUID turnId, JsonNode updatedOffer) {
        super(message);
        this.status = status;
        this.code = code;
        this.turnId = turnId;
        this.updatedOffer = updatedOffer;
    }
}
