package ru.softline.support.health;

import org.springframework.dao.DataAccessException;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HealthController {
    private final JdbcClient jdbc;

    public HealthController(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    @GetMapping("/health/live")
    Probe live() {
        return new Probe("up");
    }

    @GetMapping("/health/ready")
    ResponseEntity<Probe> ready() {
        try {
            jdbc.sql("SELECT 1").query(Integer.class).single();
            return ResponseEntity.ok(new Probe("up"));
        } catch (DataAccessException exception) {
            return ResponseEntity.status(503).body(new Probe("down"));
        }
    }

    record Probe(String status) {}
}
