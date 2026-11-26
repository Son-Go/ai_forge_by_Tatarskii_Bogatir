package ru.softline.support.chat;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashMap;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
class ManagerAccess {
    private final Map<String, byte[]> tokens = new HashMap<>();

    ManagerAccess(@Value("${MANAGER_ACCESS_TOKENS:}") String config) {
        if (config.isBlank()) return;
        for (String entry : config.split(",", -1)) {
            String[] parts = entry.strip().split("=", -1);
            if (parts.length != 2 || !parts[0].matches("[A-Za-z0-9_-]{1,64}") || !validToken(parts[1])) {
                throw new IllegalArgumentException("Invalid MANAGER_ACCESS_TOKENS format");
            }
            byte[] digest = hash(parts[1]);
            if (tokens.containsKey(parts[0]) || tokens.values().stream().anyMatch(token -> MessageDigest.isEqual(token, digest))) {
                throw new IllegalArgumentException("Duplicate manager ID or token");
            }
            tokens.put(parts[0], digest);
        }
    }

    String requireManager(String authorization) {
        if (authorization != null && authorization.regionMatches(true, 0, "Bearer ", 0, 7)) {
            String token = authorization.substring(7);
            if (validToken(token)) {
                byte[] digest = hash(token);
                for (var manager : tokens.entrySet()) {
                    if (MessageDigest.isEqual(manager.getValue(), digest)) return manager.getKey();
                }
            }
        }
        throw new ChatError(401, "MANAGER_AUTH_REQUIRED", "Требуется авторизация менеджера.");
    }

    private static boolean validToken(String token) {
        return token.length() >= 43 && token.length() <= 128 && token.matches("[A-Za-z0-9_-]+");
    }

    private static byte[] hash(String token) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException(ex);
        }
    }
}
