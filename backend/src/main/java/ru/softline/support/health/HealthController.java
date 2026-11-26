package ru.softline.support.health;

import org.springframework.dao.DataAccessException;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import ru.softline.support.catalog.CatalogSearch;

@RestController
public class HealthController {
    private final CatalogSearch catalog;

    public HealthController(CatalogSearch catalog) {
        this.catalog = catalog;
    }

    @GetMapping("/health/live")
    Probe live() {
        return new Probe("up");
    }

    @GetMapping("/health/ready")
    ResponseEntity<Probe> ready() {
        try {
            if (catalog.activeVersion().isPresent()) {
                return ResponseEntity.ok(new Probe("up"));
            }
        } catch (DataAccessException ignored) {
            // A catalog version can only be confirmed while PostgreSQL is reachable.
        }
        return ResponseEntity.status(503).body(new Probe("down"));
    }

    record Probe(String status) {}
}
