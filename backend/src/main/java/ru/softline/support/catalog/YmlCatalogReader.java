package ru.softline.support.catalog;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.InputStream;
import java.math.BigDecimal;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.xml.stream.XMLInputFactory;
import javax.xml.stream.XMLStreamConstants;
import javax.xml.stream.XMLStreamException;
import javax.xml.stream.XMLStreamReader;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

@Component
class YmlCatalogReader {
    private static final Pattern USERS = Pattern.compile("(\\d{1,8})\\s*(?:пользовател|user)", Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
    private static final Pattern MONTHS = Pattern.compile("(\\d{1,5})\\s*(мес\\S*|месяц\\S*|год\\S*|лет|months?|years?)",
            Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
    private static final Pattern POSITIVE_INT = Pattern.compile("\\d{1,8}");
    private static final int BATCH = 750;
    private static final String INSERT = """
        INSERT INTO catalog_offers (import_id, offer_id, group_id, category_id, vendor, vendor_code, name,
            description, product_url, currency, price, available, edition, license_kind, seats,
            license_term_months, updates_term_months, support_term_months, deployment, platform,
            registry_number, raw_attributes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS jsonb))
        """;
    private final JdbcTemplate db;
    private final ObjectMapper json;

    YmlCatalogReader(JdbcTemplate db, ObjectMapper json) {
        this.db = db;
        this.json = json;
    }

    Stats load(Path file, UUID id, ZoneId zone) {
        XMLInputFactory factory = XMLInputFactory.newFactory();
        factory.setProperty(XMLInputFactory.SUPPORT_DTD, false);
        factory.setProperty(XMLInputFactory.IS_SUPPORTING_EXTERNAL_ENTITIES, false);
        factory.setXMLResolver((publicId, systemId, base, namespace) -> {
            throw new XMLStreamException("External XML references are disabled");
        });
        try (InputStream input = Files.newInputStream(file)) {
            XMLStreamReader xml = factory.createXMLStreamReader(input);
            try {
                return read(xml, id, zone);
            } finally {
                xml.close();
            }
        } catch (java.io.IOException | XMLStreamException ex) {
            throw new CatalogSync.Problem("FEED_XML_INVALID", ex);
        }
    }

    private Stats read(XMLStreamReader xml, UUID id, ZoneId zone) throws XMLStreamException {
        int seen = 0;
        boolean categoriesSaved = false;
        OffsetDateTime snapshotAt = null;
        Map<String, Category> categories = new LinkedHashMap<>();
        List<OfferRow> offers = new ArrayList<>(BATCH);
        while (xml.hasNext() && xml.next() != XMLStreamConstants.START_ELEMENT) { /* root */ }
        if (!"yml_catalog".equals(xml.getLocalName())) throw new CatalogSync.Problem("FEED_XML_INVALID");
        String stamp = xml.getAttributeValue(null, "date");
        if (stamp != null) {
            try {
                String value = stamp.replace(' ', 'T');
                snapshotAt = java.time.temporal.ChronoField.OFFSET_SECONDS.isSupportedBy(
                        DateTimeFormatter.ISO_DATE_TIME.parse(value))
                        ? OffsetDateTime.parse(value)
                        : LocalDateTime.parse(value).atZone(zone).toOffsetDateTime();
            } catch (java.time.DateTimeException ex) {
                throw new CatalogSync.Problem("FEED_DATE_INVALID", ex);
            }
        }
        while (xml.hasNext()) {
            int event = xml.next();
            if (event != XMLStreamConstants.START_ELEMENT) continue;
            if ("category".equals(xml.getLocalName()) && !categoriesSaved) {
                String categoryId = required(xml.getAttributeValue(null, "id"));
                String parent = clean(xml.getAttributeValue(null, "parentId"));
                Category category = new Category(categoryId, parent, required(xml.getElementText()));
                if (categories.putIfAbsent(categoryId, category) != null) throw new CatalogSync.Problem("FEED_DUPLICATE_CATEGORY");
            } else if ("offer".equals(xml.getLocalName())) {
                if (!categoriesSaved) {
                    saveCategories(id, categories);
                    categoriesSaved = true;
                }
                offers.add(readOffer(xml));
                seen++;
                if (offers.size() == BATCH) {
                    saveOffers(id, offers);
                    offers.clear();
                }
            }
        }
        saveOffers(id, offers);
        if (seen == 0) throw new CatalogSync.Problem("FEED_EMPTY");
        return new Stats(seen, categories.size(), snapshotAt);
    }

    private OfferRow readOffer(XMLStreamReader xml) throws XMLStreamException {
        String id = required(xml.getAttributeValue(null, "id"));
        String group = clean(xml.getAttributeValue(null, "group_id"));
        String availableText = clean(xml.getAttributeValue(null, "available"));
        Boolean available = switch (availableText == null ? "" : availableText) {
            case "true" -> true;
            case "false" -> false;
            case "" -> null;
            default -> throw new CatalogSync.Problem("FEED_AVAILABILITY_INVALID");
        };
        Map<String, String> fields = new HashMap<>();
        Map<String, List<String>> parameters = new LinkedHashMap<>();
        while (xml.hasNext()) {
            int event = xml.next();
            if (event == XMLStreamConstants.END_ELEMENT && "offer".equals(xml.getLocalName())) break;
            if (event != XMLStreamConstants.START_ELEMENT) continue;
            String key = xml.getLocalName();
            if ("param".equals(key)) {
                String name = required(xml.getAttributeValue(null, "name"));
                parameters.computeIfAbsent(name, ignored -> new ArrayList<>()).add(xml.getElementText());
            } else if (List.of("name", "description", "url", "currencyId", "price", "vendor", "vendorCode",
                    "group_id", "categoryId").contains(key)) {
                fields.putIfAbsent(key, clean(xml.getElementText()));
            } else {
                skip(xml);
            }
        }
        String name = required(fields.get("name"));
        String currency = clean(fields.get("currencyId"));
        String rawPrice = fields.get("price");
        BigDecimal price = null;
        try {
            if (rawPrice != null) {
                price = new BigDecimal(rawPrice);
                if (price.signum() < 0 || price.precision() > 20 || Math.abs((long) price.scale()) > 8) {
                    throw new NumberFormatException();
                }
                if (price.signum() > 0 && (currency == null || !currency.matches("[A-Z]{3}"))) {
                    throw new CatalogSync.Problem("FEED_CURRENCY_INVALID");
                }
            }
        } catch (NumberFormatException ex) {
            throw new CatalogSync.Problem("FEED_PRICE_INVALID", ex);
        }
        String license = first(parameters, "Тип лицензии");
        String licenseKind = licenseKind(name, license);
        Integer seats = numeric(first(parameters, "К-во пользователей до"), POSITIVE_INT, 0);
        if (seats == null) seats = numeric(name, USERS, 1);
        return new OfferRow(id, group == null ? fields.get("group_id") : group, fields.get("categoryId"),
                fields.get("vendor"), fields.get("vendorCode"), name, fields.get("description"), validUrl(fields.get("url")),
                currency, price, available, first(parameters, "Версия"), licenseKind, seats,
                months(first(parameters, "Срок действия")), months(first(parameters, "Срок обновлений")),
                months(first(parameters, "Срок поддержки")), first(parameters, "Тип развёртывания", "Тип развертывания"),
                first(parameters, "Операционная система", "Совместимые платформы", "Совместимая архитектура/платформа"),
                first(parameters, "Номер записи в реестре отечественного ПО"), parameters);
    }

    private static void skip(XMLStreamReader xml) throws XMLStreamException {
        int level = 1;
        while (level > 0 && xml.hasNext()) {
            int event = xml.next();
            if (event == XMLStreamConstants.START_ELEMENT) level++;
            if (event == XMLStreamConstants.END_ELEMENT) level--;
        }
    }

    private void saveCategories(UUID id, Map<String, Category> categories) {
        List<Category> ordered = new ArrayList<>();
        Map<String, String> paths = new HashMap<>();
        for (Category item : categories.values()) {
            List<Category> parents = new ArrayList<>();
            Category next = item;
            while (next != null && !paths.containsKey(next.id())) {
                if (parents.contains(next)) throw new CatalogSync.Problem("FEED_CATEGORY_CYCLE");
                parents.add(next);
                String parent = next.parent();
                next = parent == null ? null : categories.get(parent);
                if (parent != null && next == null) throw new CatalogSync.Problem("FEED_CATEGORY_PARENT_UNKNOWN");
            }
            for (Category category : parents.reversed()) {
                ordered.add(category);
                paths.put(category.id(), category.parent() == null ? category.name()
                        : paths.get(category.parent()) + " / " + category.name());
            }
        }
        db.batchUpdate("INSERT INTO catalog_categories (import_id,category_id,parent_id,name,path) VALUES (?,?,?,?,?)",
                ordered, BATCH, (ps, category) -> {
                    ps.setObject(1, id);
                    ps.setString(2, category.id());
                    ps.setString(3, category.parent());
                    ps.setString(4, category.name());
                    ps.setString(5, paths.get(category.id()));
                });
    }

    private void saveOffers(UUID id, List<OfferRow> offers) {
        if (offers.isEmpty()) return;
        db.batchUpdate(INSERT, offers, BATCH, (ps, row) -> saveOffer(ps, id, row));
    }

    private void saveOffer(PreparedStatement ps, UUID id, OfferRow row) throws SQLException {
        ps.setObject(1, id);
        Object[] columns = {row.id(), row.group(), row.category(), row.vendor(), row.code(), row.name(),
                row.description(), row.url(), row.currency(), row.price(), row.available(), row.edition(),
                row.licenseKind(), row.seats(), row.term(), row.updates(), row.support(), row.deployment(),
                row.platform(), row.registry(), encode(row.parameters())};
        for (int index = 0; index < columns.length; index++) ps.setObject(index + 2, columns[index]);
    }

    private String encode(Map<String, List<String>> raw) {
        try {
            return json.writeValueAsString(raw);
        } catch (JsonProcessingException ex) {
            throw new CatalogSync.Problem("FEED_PARAMETERS_INVALID", ex);
        }
    }

    private static String validUrl(String value) {
        try {
            URI uri = URI.create(required(value));
            if ("https".equalsIgnoreCase(uri.getScheme()) && uri.getHost() != null && uri.getUserInfo() == null) {
                return uri.toASCIIString();
            }
        } catch (IllegalArgumentException ex) {
            throw new CatalogSync.Problem("FEED_URL_INVALID", ex);
        }
        throw new CatalogSync.Problem("FEED_URL_INVALID");
    }

    private static String licenseKind(String name, String license) {
        String term = (name + " " + (license == null ? "" : license)).toLowerCase(Locale.ROOT);
        if (term.contains("продлен") || term.contains("продлён") || term.contains("renewal")) return "renewal";
        if (term.contains("новая лиценз") || term.contains("новая подпис") || term.contains("базовая лиценз")
                || term.contains("new license") || "полная версия".equalsIgnoreCase(license)) return "new";
        if (term.contains("(лицензия с подпиской") || term.contains("новая покупка")) return "new";
        return null;
    }

    private static Integer months(String value) {
        if (value == null) return null;
        Matcher match = MONTHS.matcher(value.toLowerCase(Locale.ROOT));
        if (!match.find()) return null;
        int number = Integer.parseInt(match.group(1));
        String unit = match.group(2);
        return number == 0 ? null : unit.startsWith("год") || unit.startsWith("лет") || unit.startsWith("year")
                ? number * 12 : number;
    }

    private static Integer numeric(String value, Pattern pattern, int capture) {
        if (value == null) return null;
        Matcher match = pattern.matcher(value);
        if (!(capture == 0 ? match.matches() : match.find())) return null;
        int result = Integer.parseInt(match.group(capture));
        return result > 0 ? result : null;
    }

    private static String first(Map<String, List<String>> parameters, String... keys) {
        for (String key : keys) {
            for (String raw : parameters.getOrDefault(key, List.of())) {
                String value = clean(raw);
                if (value != null && !"другое или отсутствует".equalsIgnoreCase(value)
                        && !"не определено".equalsIgnoreCase(value)) return value;
            }
        }
        return null;
    }

    private static String required(String value) {
        String result = clean(value);
        if (result == null) throw new CatalogSync.Problem("FEED_REQUIRED_FIELD");
        return result;
    }

    private static String clean(String text) {
        return text == null || text.isBlank() ? null : text.strip();
    }

    record Stats(int offers, int categories, OffsetDateTime stamp) {}
    private record Category(String id, String parent, String name) {}
    private record OfferRow(String id, String group, String category, String vendor, String code, String name,
                            String description, String url, String currency, BigDecimal price, Boolean available,
                            String edition, String licenseKind, Integer seats, Integer term, Integer updates,
                            Integer support, String deployment, String platform, String registry,
                            Map<String, List<String>> parameters) {}
}
