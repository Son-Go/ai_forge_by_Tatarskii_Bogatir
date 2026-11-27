package ru.softline.support.chat;

import static ru.softline.support.chat.ChatTypes.*;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import org.springframework.stereotype.Component;
import ru.softline.support.catalog.CatalogSearch;
import ru.softline.support.catalog.CatalogSearch.Offer;

@Component
class ReplyPlanner {
    private static final Map<String, String> QUESTIONS = Map.of(
            "product_name", "Как называется продукт? Если знаете артикул, укажите его.",
            "edition", "Какую редакцию продукта вы хотите подобрать?",
            "license_kind", "Вам нужна новая лицензия или продление?",
            "seats", "На сколько пользователей нужна лицензия?",
            "license_term_months", "На какой срок нужна лицензия?",
            "deployment", "Вам нужно облачное или локальное развёртывание?",
            "platform", "С какой ОС или платформой должно работать решение?",
            "budget_rub", "Какой у вас бюджет?",
            "domestic_required", "Нужна ли запись в реестре российского ПО?",
            "use_case", "Какую задачу должно решать ПО?");
    private final CatalogSearch catalog;
    private final FaqStore faq;

    ReplyPlanner(CatalogSearch catalog, FaqStore faq) {
        this.catalog = catalog;
        this.faq = faq;
    }

    Map<String, Object> apply(Map<String, Object> old, MlClient.Interpretation input, String text) {
        Map<String, Object> next = new LinkedHashMap<>(old);
        Map<String, Object> changes = new LinkedHashMap<>();
        for (MlClient.Update update : input.updates()) {
            if (update == null || update.field() == null || !QUESTIONS.containsKey(update.field())) continue;
            String field = update.field();
            if ("clear".equals(update.op())) {
                changes.put(field, null);
            } else if ("set".equals(update.op()) && update.evidence() != null && !update.evidence().isBlank()
                    && normalize(text).contains(normalize(update.evidence()))) {
                Object value = value(field, update.value());
                if (value != null) changes.put(field, value);
            }
        }
        if (!"product_question".equals(input.intent()) && changes.get("product_name") != null
                && !Objects.equals(old.get("product_name"), changes.get("product_name"))) {
            next.remove("edition");
        }
        changes.forEach((field, value) -> {
            if (value == null) next.remove(field); else next.put(field, value);
        });
        return next;
    }

    Reply explicitHandoff(String message) {
        String text = normalize(message);
        boolean documentReview = (text.contains("документ") || text.contains("справк"))
                && (text.contains("проверь") || text.contains("проверить") || text.contains("проверка документ")
                    || text.contains("проверите") || text.contains("подтвердите") || text.contains("подтвердить")
                    || text.contains("согласуйте") || text.contains("согласовать"));
        if (documentReview && !text.startsWith("какие документ")) {
            return Reply.handoff("document_review", "Передали обращение менеджеру для проверки документов. "
                    + "Он ответит в этом диалоге.");
        }
        if (text.contains("под заказ") || text.contains("вне каталога") || text.contains("вне витрины")
                || text.contains("нет в каталоге") || text.contains("нет на сайте")
                || text.contains("не нашел на сайте") || text.contains("не нашла на сайте")
                || text.contains("проверьте возможность поставки") || text.contains("уточните возможность поставки")
                || text.contains("проверьте поставку")) return offCatalog();
        return null;
    }

    Reply faqAnswer(Turn turn, MlClient.Interpretation interpretation, Map<String, Object> requirements) {
        if (!"product_question".equals(interpretation.intent())) return null;
        String key = FaqText.key(turn.userText());
        return faq.lookup(turn.userText(), explicitValue(key, requirements.get("product_name")),
                explicitValue(key, requirements.get("edition")));
    }

    private static String explicitValue(String questionKey, Object value) {
        String text = query(value);
        return text != null && FaqText.contains(questionKey, FaqText.key(text)) ? text : null;
    }

    Reply plan(Turn turn, MlClient.Interpretation input, Map<String, Object> requirements) {
        String product = query(requirements.get("product_name"));
        String useCase = query(requirements.get("use_case"));
        String modelQuery = query(input.productQuery());
        if ("product_question".equals(input.intent())) {
            return question(turn, modelQuery, product, useCase);
        }
        boolean known = "known_product".equals(input.intent());
        String search = known ? first(product, modelQuery) : first(modelQuery, useCase);
        if (search == null) return Reply.text("clarify", QUESTIONS.get(known ? "product_name" : "use_case"));
        List<Offer> found = catalog.find(turn.catalogVersion(), search, true);
        if (found.isEmpty() && known && modelQuery != null && !normalize(modelQuery).equals(normalize(search))) {
            found = catalog.find(turn.catalogVersion(), modelQuery, true);
        }
        if (found.isEmpty()) {
            if (known) return offCatalog();
            return Reply.text("insufficient_data", "Подходящую позицию в текущем каталоге подтвердить не удалось. "
                    + "Уточните требования или название продукта.");
        }
        if (known && product != null) {
            List<Offer> exact = found.stream().filter(offer -> matchesProduct(offer, search)).toList();
            if (exact.isEmpty()) {
                var family = found.stream().filter(offer -> matchesProduct(offer, modelQuery)).findFirst();
                if (family.isPresent()) {
                    return offerReply("insufficient_data", "Найдено похожее семейство. "
                            + "Точное название и редакцию нужно подтвердить по артикулу.", List.of(family.get()));
                }
                return Reply.text("insufficient_data", "Точное совпадение в каталоге не подтверждено. "
                        + "Уточните артикул или скажите, рассматриваете ли вы замену.");
            }
            found = exact;
        }
        List<Offer> filtered = found.stream().filter(offer -> matches(offer, requirements, false)).toList();
        if (filtered.isEmpty()) {
            return Reply.text("insufficient_data", "В текущем каталоге нет подтверждённого варианта с такими параметрами. "
                    + "Проверьте требования или уточните возможность поставки у менеджера.");
        }
        for (String field : input.clarificationCandidates()) {
            if (field == null || !QUESTIONS.containsKey(field) || requirements.containsKey(field)) continue;
            if (known && "edition".equals(field) && filtered.stream().noneMatch(offer -> offer.edition() != null)) continue;
            return Reply.text("clarify", QUESTIONS.get(field));
        }
        List<Offer> confirmed = filtered.stream().filter(o -> matches(o, requirements, true)).limit(3).toList();
        if (confirmed.isEmpty()) {
            return offerReply("insufficient_data", "Найдено семейство или похожие позиции. "
                    + "Некоторые запрошенные параметры отсутствуют в каталоге и требуют подтверждения.", filtered.subList(0, 1));
        }
        return offerReply("recommend", "По текущему снимку каталога найдены варианты с подтверждёнными параметрами.", confirmed);
    }

    private static Reply offCatalog() {
        return Reply.handoff("off_catalog_order", "Передали запрос менеджеру, чтобы проверить возможность поставки. "
                + "Если знаете производителя или артикул, напишите их здесь.");
    }

    private Reply question(Turn turn, String query, String product, String useCase) {
        String topic = first(useCase, query);
        var articles = catalog.knowledge(topic);
        if (!articles.isEmpty()) {
            List<Fact> facts = new ArrayList<>();
            List<JsonNode> sources = new ArrayList<>();
            for (var article : articles) {
                facts.add(new Fact("f" + (facts.size() + 1), "По справке «" + article.title() + "»: "
                        + article.text().strip()));
                sources.add(catalog.source(article));
            }
            return new Reply("answer", facts, List.of(), sources);
        }
        var offers = catalog.find(turn.catalogVersion(), first(product, query), false);
        return offers.stream().filter(offer -> matchesProduct(offer, first(product, query))).findFirst()
                .map(offer -> offerReply("answer", "Вот что подтверждено в текущем снимке каталога. "
                        + "Отсутствующие в карточке характеристики нужно уточнить.", List.of(offer)))
                .orElseGet(() -> Reply.text("insufficient_data", "Подтверждённого ответа в каталоге и справке пока нет."));
    }

    private Reply offerReply(String outcome, String intro, List<Offer> offers) {
        List<Fact> facts = new ArrayList<>();
        facts.add(new Fact("f1", intro));
        for (Offer offer : offers) {
            List<String> data = new ArrayList<>();
            if (offer.seats() != null) data.add("пользователей: " + offer.seats());
            if (offer.term() != null) data.add("срок лицензии: " + offer.term() + " мес.");
            if (offer.updatesTerm() != null) data.add("срок обновлений: " + offer.updatesTerm() + " мес.");
            if (offer.platform() != null) data.add("платформа: " + offer.platform());
            if (offer.licenseKind() != null) data.add("renewal".equals(offer.licenseKind()) ? "продление" : "новая лицензия");
            if (offer.registryNumber() != null) data.add("номер записи в реестре: " + offer.registryNumber());
            String suffix = data.isEmpty() ? "" : " (" + String.join(", ", data) + ")";
            facts.add(new Fact("f" + (facts.size() + 1), offer.name() + suffix + "."));
        }
        return new Reply(outcome, facts, offers.stream().map(catalog::card).toList(),
                offers.stream().map(catalog::source).toList());
    }

    private static boolean matches(Offer o, Map<String, Object> r, boolean requireEvidence) {
        if (!equalsOrUnknown(r.get("edition"), o.edition(), requireEvidence)
                || !equalsOrUnknown(r.get("license_kind"), o.licenseKind(), requireEvidence)
                || !equalsOrUnknown(r.get("platform"), o.platform(), requireEvidence)
                || !equalsOrUnknown(r.get("deployment"), o.deployment(), requireEvidence)) return false;
        if (r.get("seats") instanceof Number seats && (o.seats() == null ? requireEvidence : o.seats() < seats.intValue())) return false;
        if (r.get("license_term_months") instanceof Number term && (o.term() == null ? requireEvidence : !o.term().equals(term.intValue()))) return false;
        if (Boolean.TRUE.equals(r.get("domestic_required"))
                && (o.registryNumber() == null || !o.registryNumber().matches("[0-9]+"))) return !requireEvidence;
        if (r.get("budget_rub") instanceof String budget) {
            if (o.price() == null || o.price().signum() == 0 || !List.of("RUB", "RUR").contains(Objects.toString(o.currency(), ""))) {
                return !requireEvidence;
            }
            return o.price().compareTo(new BigDecimal(budget)) <= 0;
        }
        return true;
    }

    private static boolean matchesProduct(Offer offer, String query) {
        return query != null && (offer.id().equals(query) || query.equalsIgnoreCase(offer.vendorCode())
                || normalize(offer.name()).contains(normalize(query)));
    }

    private static boolean equalsOrUnknown(Object wanted, String actual, boolean requireEvidence) {
        return wanted == null || (actual == null ? !requireEvidence
                : java.util.regex.Pattern.compile("(?U)(^|[^\\p{L}\\p{N}])"
                        + java.util.regex.Pattern.quote(normalize(wanted.toString())) + "($|[^\\p{L}\\p{N}])")
                        .matcher(normalize(actual)).find());
    }

    private static Object value(String field, JsonNode value) {
        if (value == null) return null;
        return switch (field) {
            case "seats", "license_term_months" -> value.isIntegralNumber() && value.canConvertToInt()
                    && value.intValue() > 0 ? value.intValue() : null;
            case "domestic_required" -> value.isBoolean() ? value.booleanValue() : null;
            case "license_kind" -> value.isTextual() && List.of("new", "renewal").contains(value.textValue())
                    ? value.textValue() : null;
            case "budget_rub" -> value.isTextual() && value.textValue().matches("[0-9]{1,14}(\\.[0-9]{1,4})?")
                    ? value.textValue() : null;
            default -> value.isTextual() ? query(value.textValue()) : null;
        };
    }

    private static String query(Object value) {
        if (!(value instanceof String text) || text.isBlank() || text.length() > 400) return null;
        return text.strip();
    }

    private static String first(String value, String fallback) { return value == null ? fallback : value; }

    private static String normalize(String value) {
        return value.toLowerCase(Locale.ROOT).replace('ё', 'е').strip();
    }
}
