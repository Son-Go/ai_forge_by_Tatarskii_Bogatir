package ru.softline.support.catalog;

import java.io.BufferedInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.HexFormat;
import java.util.UUID;
import java.util.zip.GZIPInputStream;
import javax.sql.DataSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.scheduling.support.CronExpression;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

@Service
class CatalogSync {
    private static final Logger log = LoggerFactory.getLogger(CatalogSync.class);
    private static final long LOCK_ID = 2711262026L;
    private static final long MAX_FEED = 1024L * 1024 * 1024;
    private final JdbcClient db;
    private final DataSource dataSource;
    private final TransactionTemplate tx;
    private final YmlCatalogReader reader;
    private final String source;
    private final Path local;
    private final ZoneId zone;
    private final CronExpression cron;
    private final int minPercent;
    private boolean localStartup = true;

    CatalogSync(JdbcClient db, DataSource dataSource, TransactionTemplate tx, YmlCatalogReader reader,
                @Value("${catalog.feed-url}") String url, @Value("${catalog.feed-file}") String file,
                @Value("${catalog.sync-zone}") String zone, @Value("${catalog.sync-cron}") String cron,
                @Value("${catalog.minimum-offer-percent:80}") int minPercent) {
        this.db = db;
        this.dataSource = dataSource;
        this.tx = tx;
        this.reader = reader;
        this.local = file.isBlank() ? null : Path.of(file);
        this.source = local == null ? url : local.toString();
        this.zone = ZoneId.of(zone);
        this.cron = CronExpression.parse(cron);
        if (minPercent < 1 || minPercent > 100) throw new IllegalArgumentException("Invalid catalog minimum percentage");
        this.minPercent = minPercent;
    }

    @Scheduled(fixedDelayString = "${catalog.check-delay-ms:60000}", initialDelay = 1000)
    public void check() {
        if (source.isBlank()) return;
        ZonedDateTime now = ZonedDateTime.now(zone);
        final boolean localFirst = local != null && localStartup;
        try (Connection lock = dataSource.getConnection()) {
            if (!advisory(lock, "SELECT pg_try_advisory_lock(?)")) return;
            try {
                db.sql("""
                    UPDATE catalog_sync_runs SET status = 'failed', error_code = 'SYNC_INTERRUPTED', finished_at = now()
                    WHERE status = 'running'
                    """).update();
                Active active = active();
                ZonedDateTime today = now.toLocalDate().atStartOfDay(zone);
                ZonedDateTime due = cron.next(today.minusNanos(1));
                if (active != null && !localFirst && (due == null || due.isAfter(now))) return;
                if (sync(now.toLocalDate(), active, localFirst)) localStartup = false;
            } finally {
                advisory(lock, "SELECT pg_advisory_unlock(?)");
            }
        } catch (RuntimeException | SQLException ex) {
            log.warn("Catalog check could not start: {}", ex.getClass().getSimpleName());
        }
    }

    private boolean sync(LocalDate date, Active active, boolean force) {
        Run previous = db.sql("""
            SELECT attempt, status, finished_at FROM catalog_sync_runs
            WHERE scheduled_date = ? ORDER BY attempt DESC LIMIT 1
            """).param(date).query((rs, n) -> new Run(rs.getInt(1), rs.getString(2),
                rs.getObject(3, OffsetDateTime.class))).optional().orElse(null);
        if (previous != null && !force && (!"failed".equals(previous.status()) || previous.attempt() >= 3
                || previous.finished().plusMinutes(previous.attempt()).isAfter(OffsetDateTime.now()))) return false;
        if (force && previous != null && "failed".equals(previous.status()) && previous.finished() != null
                && previous.finished().plusMinutes(1).isAfter(OffsetDateTime.now())) return true;
        UUID run = UUID.randomUUID();
        db.sql("""
            INSERT INTO catalog_sync_runs (run_id, scheduled_date, attempt, source, status)
            VALUES (?, ?, ?, ?, 'running')
            """).params(run, date, previous == null ? 1 : previous.attempt() + 1, source).update();
        Path xml = null;
        Integer status = null;
        try {
            xml = Files.createTempFile("softline-feed-", ".xml");
            Download download = receive(xml, active);
            status = download.status();
            if (active != null && source.equals(active.source())
                    && (Integer.valueOf(304).equals(status) || active.sha().equals(download.sha()))) {
                tx.executeWithoutResult(transaction -> {
                    if (Integer.valueOf(200).equals(download.status())) {
                        db.sql("UPDATE catalog_imports SET etag = :etag, last_modified = :modified WHERE import_id = :id")
                                .param("etag", download.etag()).param("modified", download.modified())
                                .param("id", active.id()).update();
                    }
                    finish(run, "unchanged", download.status(), null, active.id());
                });
            } else {
                final Path input = xml;
                tx.executeWithoutResult(transaction -> activate(run, input, download, active));
            }
            log.info("Catalog check complete run_id={}", run);
        } catch (RuntimeException | IOException ex) {
            String code = ex instanceof Problem problem ? problem.code : "FEED_IMPORT_FAILED";
            if (ex instanceof Problem problem && problem.httpStatus != null) status = problem.httpStatus;
            finish(run, "failed", status, code, null);
            log.warn("Catalog check failed run_id={} code={}", run, code);
        } finally {
            if (xml != null) {
                try { Files.deleteIfExists(xml); }
                catch (IOException ex) { log.warn("Unable to remove catalog staging file run_id={}", run); }
            }
        }
        return true;
    }

    private void activate(UUID run, Path file, Download download, Active active) {
        UUID next = UUID.randomUUID();
        db.sql("""
            INSERT INTO catalog_imports (import_id,source,sha256,status)
            VALUES (?, ?, ?, 'loading')
            """).params(next, source, download.sha()).update();
        YmlCatalogReader.Stats stats = reader.load(file, next, zone);
        int previous = active == null ? 0 : db.sql("SELECT count(*) FROM catalog_offers WHERE import_id = ?")
                .param(active.id()).query(Integer.class).single();
        if (stats.offers() * 100L < previous * (long) minPercent) throw new Problem("FEED_TOO_SMALL");
        Counts changes = active == null ? new Counts(stats.offers(), 0, 0) : compare(active.id(), next);
        db.sql("""
            UPDATE catalog_imports SET snapshot_at = :stamp, etag = :etag, last_modified = :modified,
                added_count = :added, changed_count = :changed, removed_count = :removed, status = 'activated',
                activated_at = now(), validation_report = jsonb_build_object('offers', CAST(:offers AS integer),
                    'categories', CAST(:categories AS integer))
            WHERE import_id = :id
            """).param("stamp", stats.stamp()).param("etag", download.etag()).param("modified", download.modified())
                .param("added", changes.added()).param("changed", changes.changed()).param("removed", changes.removed())
                .param("offers", stats.offers()).param("categories", stats.categories()).param("id", next).update();
        db.sql("""
            INSERT INTO catalog_head (singleton,active_import_id) VALUES (true, ?)
            ON CONFLICT (singleton) DO UPDATE SET active_import_id = excluded.active_import_id
            """).param(next).update();
        finish(run, "activated", download.status(), null, next);
    }

    private Counts compare(UUID previous, UUID next) {
        return db.sql("""
            WITH prev AS (SELECT * FROM catalog_offers WHERE import_id = ?),
                 next AS (SELECT * FROM catalog_offers WHERE import_id = ?)
            SELECT count(*) FILTER (WHERE prev.offer_id IS NULL),
                   count(*) FILTER (WHERE prev.offer_id IS NOT NULL AND next.offer_id IS NOT NULL
                       AND (to_jsonb(prev) - 'import_id') <> (to_jsonb(next) - 'import_id')),
                   count(*) FILTER (WHERE next.offer_id IS NULL)
            FROM prev FULL JOIN next USING (offer_id)
            """).params(previous, next).query((rs, n) -> new Counts(rs.getInt(1), rs.getInt(2), rs.getInt(3))).single();
    }

    private Active active() {
        return db.sql("""
            SELECT i.import_id,i.source,i.sha256,i.etag,i.last_modified
            FROM catalog_head h JOIN catalog_imports i ON i.import_id = h.active_import_id
            """).query((rs, n) -> new Active(rs.getObject(1, UUID.class), rs.getString(2), rs.getString(3),
                    rs.getString(4), rs.getString(5))).optional().orElse(null);
    }

    private void finish(UUID run, String state, Integer httpStatus, String error, UUID version) {
        db.sql("""
            UPDATE catalog_sync_runs SET status = :state, http_status = :http, error_code = :error,
                import_id = :version, finished_at = now() WHERE run_id = :id
            """).param("state", state).param("http", httpStatus).param("error", error)
                .param("version", version).param("id", run).update();
    }

    private Download receive(Path output, Active active) throws IOException {
        if (local != null) {
            try (InputStream input = Files.newInputStream(local)) {
                return new Download(copyXml(input, output), null, null, null);
            }
        }
        URI uri = URI.create(source);
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getUserInfo() != null || uri.getHost() == null) {
            throw new Problem("FEED_ENDPOINT_INVALID");
        }
        HttpURLConnection http = (HttpURLConnection) uri.toURL().openConnection();
        http.setConnectTimeout(10000);
        http.setReadTimeout(15000);
        http.setInstanceFollowRedirects(false);
        boolean hasComparator = active != null && source.equals(active.source());
        if (hasComparator) {
            if (active.etag() != null) http.setRequestProperty("If-None-Match", active.etag());
            if (active.modified() != null) http.setRequestProperty("If-Modified-Since", active.modified());
        }
        int response = -1;
        try {
            response = http.getResponseCode();
            if (response == 304 && hasComparator) return new Download(active.sha(), 304, active.etag(), active.modified());
            if (response != 200) throw new Problem("FEED_HTTP_ERROR", response);
            if (http.getContentLengthLong() > MAX_FEED) throw new Problem("FEED_TOO_LARGE", response);
            try (InputStream input = http.getInputStream()) {
                return new Download(copyXml(input, output), response, http.getHeaderField("ETag"), http.getHeaderField("Last-Modified"));
            }
        } catch (IOException ex) {
            throw new Problem("FEED_DOWNLOAD_FAILED", response < 0 ? null : response, ex);
        } finally {
            http.disconnect();
        }
    }

    private static String copyXml(InputStream input, Path output) throws IOException {
        MessageDigest digest;
        try { digest = MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException ex) { throw new IllegalStateException(ex); }
        long deadline = System.nanoTime() + java.time.Duration.ofMinutes(5).toNanos();
        try (BufferedInputStream buffered = new BufferedInputStream(new LimitedStream(input, deadline))) {
            buffered.mark(2);
            boolean gzip = buffered.read() == 0x1f && buffered.read() == 0x8b;
            buffered.reset();
            try (DigestInputStream body = new DigestInputStream(
                    new LimitedStream(gzip ? new GZIPInputStream(buffered) : buffered, deadline), digest);
                 var file = Files.newOutputStream(output)) {
                body.transferTo(file);
            }
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    private static boolean advisory(Connection lock, String sql) throws SQLException {
        try (var statement = lock.prepareStatement(sql)) {
            statement.setLong(1, LOCK_ID);
            try (var rows = statement.executeQuery()) {
                return rows.next() && rows.getBoolean(1);
            }
        }
    }

    private static final class LimitedStream extends FilterInputStream {
        private final long deadline;
        private long count;

        LimitedStream(InputStream input, long deadline) { super(input); this.deadline = deadline; }

        @Override public int read() throws IOException {
            int result = in.read();
            check(result < 0 ? 0 : 1);
            return result;
        }

        @Override public int read(byte[] bytes, int offset, int length) throws IOException {
            int result = in.read(bytes, offset, length);
            check(Math.max(0, result));
            return result;
        }

        private void check(int read) {
            count += read;
            if (count > MAX_FEED) throw new Problem("FEED_TOO_LARGE");
            if (System.nanoTime() > deadline) throw new Problem("FEED_DOWNLOAD_TIMEOUT");
        }
    }

    static class Problem extends RuntimeException {
        final String code;
        final Integer httpStatus;
        Problem(String code) { this(code, null, null); }
        Problem(String code, Throwable cause) { this(code, null, cause); }
        Problem(String code, int httpStatus) { this(code, httpStatus, null); }
        Problem(String code, Integer httpStatus, Throwable cause) { super(code, cause); this.code = code; this.httpStatus = httpStatus; }
    }

    private record Download(String sha, Integer status, String etag, String modified) {}
    private record Active(UUID id, String source, String sha, String etag, String modified) {}
    private record Run(int attempt, String status, OffsetDateTime finished) {}
    private record Counts(int added, int changed, int removed) {}
}
