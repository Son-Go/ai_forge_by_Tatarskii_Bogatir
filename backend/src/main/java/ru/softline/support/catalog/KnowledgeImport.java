package ru.softline.support.catalog;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.net.URI;
import java.security.MessageDigest;
import java.time.OffsetDateTime;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

@Component
class KnowledgeImport implements ApplicationRunner {
    private static final Set<String> ALLOWED_HOSTS = Set.of("docs.softline.com", "docs.softline.ru", "store.softline.ru");
    private final String input;
    private final ObjectMapper json;
    private final JdbcClient db;
    private final TransactionTemplate tx;

    KnowledgeImport(@Value("${catalog.knowledge-file:}") String input,
                    ObjectMapper json, JdbcClient db, TransactionTemplate tx) {
        this.input = input;
        this.json = json;
        this.db = db;
        this.tx = tx;
    }

    @Override
    public void run(ApplicationArguments args) throws Exception {
        if (input.isBlank()) return;
        Path file = Path.of(input);
        if (Files.size(file) > 10_000_000) throw new IllegalArgumentException("Knowledge file too large");
        List<Article> articles = json.readValue(file.toFile(), new TypeReference<>() {});
        for (Article article : articles) {
            validate(article);
            String sha = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(json.writeValueAsBytes(article)));
            tx.executeWithoutResult(status -> save(article, sha));
        }
    }

    private void save(Article article, String sha) {
        UUID id = UUID.randomUUID();
        int created = db.sql("""
            INSERT INTO knowledge_documents (document_id,source_url,title,fetched_at,content_hash,version)
            VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (source_url,version) DO NOTHING
            """).params(id, article.sourceUrl(), article.title(), article.fetchedAt(), sha, article.version()).update();
        if (created == 0) {
            String previous = db.sql("SELECT content_hash FROM knowledge_documents WHERE source_url = ? AND version = ?")
                    .params(article.sourceUrl(), article.version()).query(String.class).single();
            if (!previous.equals(sha)) throw new IllegalArgumentException("Knowledge version already exists with different content");
            return;
        }
        for (Chunk chunk : article.chunks()) {
            db.sql("INSERT INTO knowledge_chunks (chunk_id,document_id,section,body) VALUES (?, ?, ?, ?)")
                    .param(UUID.randomUUID()).param(id).param(chunk.section()).param(chunk.text().strip()).update();
        }
    }

    private static void validate(Article article) {
        URI url = URI.create(article.sourceUrl());
        if (!"https".equals(url.getScheme()) || url.getHost() == null || !ALLOWED_HOSTS.contains(url.getHost())
                || url.getUserInfo() != null || blank(article.title()) || blank(article.version())
                || article.fetchedAt() == null || article.chunks() == null || article.chunks().isEmpty()) {
            throw new IllegalArgumentException("Invalid knowledge document");
        }
        for (Chunk chunk : article.chunks()) {
            if (blank(chunk.text()) || chunk.text().length() > 1800) {
                throw new IllegalArgumentException("Invalid knowledge chunk");
            }
        }
    }

    private static boolean blank(String text) { return text == null || text.isBlank(); }

    record Article(String sourceUrl, String title, OffsetDateTime fetchedAt, String version, List<Chunk> chunks) {}
    record Chunk(String section, String text) {}
}
