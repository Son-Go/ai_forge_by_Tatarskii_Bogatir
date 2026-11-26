package ru.softline.support.catalog;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

@Service
public class CatalogSearch {
    private static final String OFFER_COLUMNS = """
        SELECT o.*, i.snapshot_at, i.activated_at, c.name AS category_name
        FROM catalog_offers o JOIN catalog_imports i USING (import_id)
        LEFT JOIN catalog_categories c USING (import_id, category_id)
        """;
    private final JdbcClient db;
    private final ObjectMapper json;

    public CatalogSearch(JdbcClient db, ObjectMapper json) {
        this.db = db;
        this.json = json;
    }

    public Optional<UUID> activeVersion() {
        return db.sql("SELECT active_import_id FROM catalog_head WHERE singleton").query(UUID.class).optional();
    }

    public Optional<JsonNode> card(UUID version, String id) {
        return db.sql(OFFER_COLUMNS + " WHERE o.import_id = ? AND o.offer_id = ?")
                .params(version, id).query(this::offer).optional().map(this::card);
    }

    public List<Offer> find(UUID version, String query, boolean recommend) {
        if (query == null || query.isBlank()) return List.of();
        return db.sql(OFFER_COLUMNS + """
            WHERE o.import_id = :version AND (NOT :recommend OR o.available IS TRUE)
                AND (o.offer_id = :query OR lower(o.vendor_code) = lower(:query)
                    OR lower(o.name) LIKE lower(:contains) ESCAPE '!'
                    OR lower(o.name) % lower(:query)
                    OR to_tsvector('russian', coalesce(o.name, '') || ' ' || coalesce(o.description, ''))
                        @@ websearch_to_tsquery('russian', :query)
                    OR to_tsvector('russian', coalesce(c.name, '')) @@ websearch_to_tsquery('russian', :query))
            ORDER BY (o.offer_id = :query) DESC,
                (lower(o.vendor_code) = lower(:query)) DESC NULLS LAST,
                (lower(o.name) = lower(:query)) DESC,
                (lower(o.name) LIKE lower(:contains) ESCAPE '!') DESC,
                ts_rank(to_tsvector('russian', coalesce(o.name, '')), websearch_to_tsquery('russian', :query)) DESC,
                similarity(lower(o.name), lower(:query)) DESC, o.offer_id
            LIMIT 250
            """).param("version", version).param("recommend", recommend).param("query", query)
                .param("contains", "%" + query.replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%")
                .query(this::offer).list();
    }

    public List<Knowledge> knowledge(String query) {
        if (query == null || query.isBlank()) return List.of();
        return db.sql("""
            SELECT c.chunk_id, c.body, d.title, d.source_url, d.fetched_at
            FROM knowledge_chunks c JOIN knowledge_documents d USING (document_id)
            WHERE to_tsvector('russian', c.body) @@ websearch_to_tsquery('russian', ?)
                AND NOT EXISTS (SELECT 1 FROM knowledge_documents newer WHERE newer.source_url = d.source_url
                    AND (newer.fetched_at, newer.document_id) > (d.fetched_at, d.document_id))
            ORDER BY ts_rank(to_tsvector('russian', c.body), websearch_to_tsquery('russian', ?)) DESC,
                c.chunk_id LIMIT 3
            """).params(query, query).query((rs, n) -> new Knowledge(rs.getObject("chunk_id", UUID.class),
                rs.getString("body"), rs.getString("title"), rs.getString("source_url"),
                rs.getObject("fetched_at", OffsetDateTime.class).toInstant())).list();
    }

    public JsonNode card(Offer offer) {
        ObjectNode card = json.createObjectNode();
        card.put("offer_id", offer.id()).put("catalog_version", offer.version().toString())
                .put("name", offer.name()).put("product_url", offer.url()).put("availability", offer.availability());
        if (offer.price() != null && offer.price().signum() > 0 && offer.currency() != null) {
            card.putObject("price").put("amount", offer.price().stripTrailingZeros().toPlainString())
                    .put("currency", "RUR".equals(offer.currency()) ? "RUB" : offer.currency());
        } else {
            card.putNull("price");
        }
        ObjectNode attributes = card.putObject("attributes");
        if (offer.vendorCode() != null) attributes.put("vendor_code", offer.vendorCode());
        if (offer.edition() != null) attributes.put("edition", offer.edition());
        if (offer.licenseKind() != null) attributes.put("license_kind", offer.licenseKind());
        if (offer.seats() != null) attributes.put("seats", offer.seats());
        if (offer.term() != null) attributes.put("license_term_months", offer.term());
        if (offer.updatesTerm() != null) attributes.put("updates_term_months", offer.updatesTerm());
        if (offer.supportTerm() != null) attributes.put("support_term_months", offer.supportTerm());
        if (offer.platform() != null) attributes.put("platform", offer.platform());
        if (offer.deployment() != null) attributes.put("deployment", offer.deployment());
        if (offer.registryNumber() != null) attributes.put("registry_number", offer.registryNumber());
        card.putArray("source_ids").add(offer.sourceId());
        return card;
    }

    public JsonNode source(Offer offer) {
        return json.createObjectNode().put("id", offer.sourceId()).put("title", offer.name()).put("url", offer.url())
                .put("kind", "catalog").put("snapshot_at", offer.snapshotAt().toString());
    }

    public JsonNode source(Knowledge knowledge) {
        return json.createObjectNode().put("id", knowledge.id().toString()).put("title", knowledge.title())
                .put("url", knowledge.url()).put("kind", "knowledge").put("checked_at", knowledge.checkedAt().toString());
    }

    private Offer offer(ResultSet rs, int n) throws SQLException {
        OffsetDateTime snapshot = rs.getObject("snapshot_at", OffsetDateTime.class);
        if (snapshot == null) snapshot = rs.getObject("activated_at", OffsetDateTime.class);
        Boolean available = rs.getObject("available", Boolean.class);
        return new Offer(rs.getObject("import_id", UUID.class), rs.getString("offer_id"), rs.getString("name"),
                rs.getString("vendor_code"), rs.getString("product_url"), rs.getBigDecimal("price"),
                rs.getString("currency"), available == null ? "unknown" : available ? "available" : "unavailable",
                rs.getString("edition"), rs.getString("license_kind"), rs.getObject("seats", Integer.class),
                rs.getObject("license_term_months", Integer.class), rs.getObject("updates_term_months", Integer.class),
                rs.getObject("support_term_months", Integer.class), rs.getString("platform"), rs.getString("deployment"),
                rs.getString("registry_number"), snapshot.toInstant());
    }

    public record Offer(UUID version, String id, String name, String vendorCode, String url, BigDecimal price,
                        String currency, String availability, String edition, String licenseKind, Integer seats,
                        Integer term, Integer updatesTerm, Integer supportTerm, String platform, String deployment,
                        String registryNumber, Instant snapshotAt) {
        public String sourceId() { return "offer-" + id; }
    }

    public record Knowledge(UUID id, String text, String title, String url, Instant checkedAt) {}
}
