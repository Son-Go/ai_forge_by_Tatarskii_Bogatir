package ru.softline.support.chat;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

@RestControllerAdvice(assignableTypes = {ChatController.class, ManagerController.class})
class ChatErrors {
    @ExceptionHandler({HttpMessageNotReadableException.class, MethodArgumentTypeMismatchException.class})
    ResponseEntity<Map<String, Object>> invalidRequest() { return error(invalid()); }

    @ExceptionHandler(ChatError.class)
    ResponseEntity<Map<String, Object>> error(ChatError error) {
        Map<String, Object> body = new HashMap<>();
        body.put("code", error.code);
        body.put("message", error.getMessage());
        body.put("request_id", UUID.randomUUID().toString());
        if (error.turnId != null) body.put("turn_id", error.turnId);
        if (error.updatedOffer != null) body.put("updated_offer", error.updatedOffer);
        var response = ResponseEntity.status(error.status).contentType(MediaType.APPLICATION_JSON)
                .header(HttpHeaders.CACHE_CONTROL, "no-store");
        if (error.status == 401) response.header(HttpHeaders.WWW_AUTHENTICATE, "Bearer");
        return response.body(body);
    }

    static ChatError invalid() {
        return new ChatError(400, "INVALID_REQUEST", "Проверьте поля запроса и длину сообщения.");
    }
}
