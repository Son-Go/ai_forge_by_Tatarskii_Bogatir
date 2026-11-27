package ru.softline.support.chat;

import static ru.softline.support.chat.ChatTypes.*;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import org.springframework.stereotype.Component;
import ru.softline.support.catalog.CatalogSearch;
import ru.softline.support.catalog.CatalogSearch.Knowledge;
import ru.softline.support.catalog.CatalogSearch.Offer;

@Component
class ReplyPlanner {
    private static final Pattern SOFT_REGISTRY = Pattern.compile(
            "(?U)\\b(?:желательно|предпочтительно|по возможности|если есть)(?: [\\p{L}]+){0,5} "
            + "(?:реестр[а-я]*|российск[а-я]*)\\b");
    private static final Pattern STRICT_REGISTRY = Pattern.compile(
            "(?U)\\b(?:обязательно|только|строго|непременно)(?: [\\p{L}]+){0,5} "
            + "(?:реестр[а-я]*|российск[а-я]*)\\b");
    private static final Pattern QUESTION_WORD = Pattern.compile(
            "(?U)\\b(?:как|какой|какая|какие|какова|где|можно ли|нужно ли|работает ли|совместим[аоы]? ли|"
            + "подходит ли|подойдет ли|поддерживает ли|сколько стоит)\\b");
    private static final Pattern PRODUCT_REFERENCE = Pattern.compile(
            "(?iuU)\\b(?:он|она|оно|они|его|не[её]|этот|эта|это|этого|ранее выбранн[а-я]*)\\b");
    private static final Pattern OS = Pattern.compile("(?U)\\b(astra linux|linux|windows|macos|mac os(?: x)?|android|ios)\\b");
    private static final Pattern LICENSE_VERSION = Pattern.compile(
            "(?:лицензия(?: с подпиской на обновления)?|продление(?: expired| просроченной)?"
            + "(?: лицензии| подписки на обновления)?) на [0-9]+ (?:год(?:а)?|лет|месяц(?:а|ев)?|мес)\\.?");
    private static final Pattern SUPPORT_PROCEDURE = Pattern.compile(
            "(?U)\\b(?:как (?:вернуть|оформить|сделать|доставля[а-я]+|активировать)|"
            + "можно ли (?:вернуть|оформить)|какие (?:условия|правила))\\b");
    private static final Pattern OWN_PURCHASE = Pattern.compile(
            "(?U)\\b(?:мой|моя|мою|моему|моей|наш|наша|нашу|у меня|у нас|купил[аи]?)\\b");
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
    private static final Map<String, String> FIELD_LABELS = Map.of(
            "edition", "редакцию", "license_kind", "тип лицензии", "seats", "число пользователей",
            "license_term_months", "срок лицензии", "platform", "совместимость с нужной платформой",
            "deployment", "способ развёртывания", "budget_rub", "цену в пределах бюджета",
            "domestic_required", "запись в реестре российского ПО");
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
                if (value != null && !(Boolean.TRUE.equals(value) && "domestic_required".equals(field)
                        && SOFT_REGISTRY.matcher(normalize(text)).find() && !STRICT_REGISTRY.matcher(normalize(text)).find())) {
                    changes.put(field, value);
                }
            }
        }
        if ("needs_solution".equals(input.intent()) && changes.get("use_case") != null
                && !Objects.equals(old.get("use_case"), changes.get("use_case")) && changes.get("product_name") == null) {
            next.remove("product_name");
            next.remove("edition");
        }
        if (changes.get("product_name") != null && !Objects.equals(old.get("product_name"), changes.get("product_name"))) {
            next.remove("edition");
        }
        changes.forEach((field, value) -> {
            if (value == null) next.remove(field); else next.put(field, value);
        });
        return next;
    }

    Reply explicitHandoff(String message, Map<String, Object> requirements) {
        String text = FaqText.key(message);
        if (CommercialRequest.wantsDeferral(text, false)) {
            return paymentDeferral();
        }
        boolean documentReview = (text.contains("документ") || text.contains("справк"))
                && (text.contains("проверь") || text.contains("проверить") || text.contains("проверка документ")
                    || text.contains("проверите") || text.contains("подтвердите") || text.contains("подтвердить")
                    || text.contains("согласуйте") || text.contains("согласовать"));
        if (documentReview && !text.startsWith("какие документ")) {
            return Reply.handoff("document_review", "Передали обращение менеджеру для проверки документов. "
                    + "Он ответит в этом диалоге.");
        }
        if (CommercialRequest.wantsSupplyCheck(text)) {
            return CommercialRequest.namesSupplyTarget(text) || query(requirements.get("product_name")) != null
                    ? offCatalog() : Reply.text("clarify", QUESTIONS.get("product_name"));
        }
        return null;
    }

    Reply commercialGuide(String message) {
        String topic = CommercialRequest.guide(FaqText.key(message));
        if (topic == null) return null;
        Reply published = faq.lookup(message, null, null);
        if (published != null) return published;
        return catalog.guide("commercial:" + topic)
                .map(guide -> guideReply(guide, null))
                .orElseGet(() -> Reply.text("insufficient_data", "deferral".equals(topic)
                        ? "В справке не удалось подтвердить общие условия отсрочки оплаты. Условия и срок нужно уточнить у менеджера."
                        : "В справке пока нет подтверждённой информации по этому вопросу. Условия нужно уточнить у менеджера."));
    }

    Reply commercialSupport(String message, String activeTopic, MlClient.Interpretation interpretation) {
        String text = FaqText.key(message);
        if (CommercialRequest.wantsDeferral(text, true) && interpretation != null && interpretation.signals() != null
                && interpretation.signals().stream().anyMatch(signal -> grounded(signal, "payment_deferral", message)
                        && CommercialRequest.deferralEvidence(FaqText.key(signal.evidence())))) {
            return paymentDeferral();
        }
        boolean hypothetical = CommercialRequest.hypothetical(text);
        if (activeTopic != null && !hypothetical && (text.matches("(?s).*(не помогл|не сработал|не решен|не решилась|все равно не).*")
                || signal(interpretation, "instruction_failed", message))) {
            return Reply.handoff("instruction_failed", "Передали обращение менеджеру. Он увидит историю и инструкцию, которую вы уже попробовали.");
        }
        String topic = null;
        if ((text.contains("ключ") || text.contains("лицензи")) && text.matches("(?s).*(не приш|не получ|не поступ).*")
                || signal(interpretation, "key_delivery", message)) topic = "key_delivery";
        else if ((text.contains("ключ") || text.contains("лицензи")) && text.matches("(?s).*(не активир|ошибк[аи] активац|не удается активир).*")
                || signal(interpretation, "key_activation", message)) topic = "key_activation";
        else if (text.matches("(?s).*(хочу возврат|вернуть (?:товар|деньги|лицензию)|как (?:сделать|оформить) возврат|"
                + "оформите возврат|условия возврата).*")
                || signal(interpretation, "refund", message)) topic = "refund";
        if (topic == null) return null;
        String selectedTopic = topic;
        boolean general = hypothetical || SUPPORT_PROCEDURE.matcher(text).find() && !OWN_PURCHASE.matcher(text).find();
        return catalog.supportGuide(topic).map(guide -> guideReply(guide, general ? null : selectedTopic)).orElse(null);
    }

    private Reply guideReply(Knowledge guide, String supportTopic) {
        return new Reply("answer", List.of(new Fact("f1", guide.text())), List.of(),
                List.of(catalog.source(guide)), null, supportTopic, null);
    }

    static boolean signal(MlClient.Interpretation interpretation, String kind, String message) {
        return interpretation != null && interpretation.signals() != null && interpretation.signals().stream()
                .anyMatch(signal -> grounded(signal, kind, message));
    }

    private static boolean grounded(MlClient.Signal signal, String kind, String message) {
        return signal != null && kind.equals(signal.kind()) && signal.evidence() != null
                && !signal.evidence().isBlank() && message.contains(signal.evidence());
    }

    private static Reply paymentDeferral() {
        return Reply.handoff("payment_deferral", "Передали просьбу об отсрочке оплаты менеджеру. Он ответит в этом диалоге.");
    }

    boolean isProductQuestion(String message, MlClient.Interpretation input) {
        return "product_question".equals(input.intent())
                || (Facet.in(FaqText.key(message)) != null && QUESTION_WORD.matcher(FaqText.key(message)).find());
    }

    Reply question(Turn turn, MlClient.Interpretation input, Map<String, Object> old) {
        String text = FaqText.key(turn.userText());
        String modelProduct = query(input.productQuery());
        String explicit = CatalogSearch.mentions(turn.userText(), modelProduct)
                && !QUESTION_WORD.matcher(FaqText.key(modelProduct)).find() ? modelProduct : null;
        Facet facet = Facet.in(text);
        boolean reference = PRODUCT_REFERENCE.matcher(text).find();
        String savedProduct = query(old.get("product_name"));
        String product = first(explicit, facet != null || reference ? savedProduct : null);
        String edition = Objects.equals(product, savedProduct) ? query(old.get("edition")) : null;
        ProductMatch match = resolveProduct(turn.catalogVersion(), product);
        String requestedEdition = first(edition, match.edition());
        Reply published = faq.lookup(turn.userText(), match.family(), requestedEdition);
        if (published == null && explicit == null && reference && product != null) {
            String subject = requestedEdition == null ? product : match.family() + " " + requestedEdition;
            published = faq.lookup(PRODUCT_REFERENCE.matcher(turn.userText()).replaceFirst(Matcher.quoteReplacement(subject)),
                    match.family(), requestedEdition);
        }
        if (published != null) return published;
        if (product == null) {
            if (facet != null) return Reply.text("clarify", QUESTIONS.get("product_name"));
            String useCase = reference ? query(old.get("use_case")) : null;
            List<Knowledge> articles = catalog.knowledge(first(useCase, first(modelProduct, turn.userText())));
            return articles.isEmpty()
                    ? Reply.text("insufficient_data", "Подтверждённого ответа в каталоге и справке пока нет.")
                    : knowledgeReply(articles);
        }

        List<Offer> offers = match.offers().stream()
                .filter(offer -> requestedEdition == null || editionMatch(offer, requestedEdition) == Match.CONFIRMED)
                .toList();
        if (facet == null) {
            if (!offers.isEmpty()) {
                return offerReply("answer", "Вот сведения о продукте из каталога. Условия указаны в карточках.",
                        offers.stream().limit(3).toList());
            }
            return Reply.text("insufficient_data", "В каталоге не удалось подтвердить товар «" + product
                    + "». Если знаете точную редакцию или артикул, напишите их.");
        }

        String os = facet == Facet.PLATFORM ? platformIn(text) : null;
        if (os != null) {
            List<Offer> compatible = offers.stream()
                    .filter(offer -> compare(offer, "platform", os) == Match.CONFIRMED)
                    .limit(3).toList();
            if (!compatible.isEmpty()) {
                return offerReply("answer", "В каталоге для «" + product
                        + "» подтверждена совместимость с " + os + ".", compatible);
            }
        }

        List<Map.Entry<Offer, String>> confirmed = offers.stream()
                .filter(offer -> facet.value(offer) != null)
                .map(offer -> Map.entry(offer, facet.value(offer))).toList();
        List<String> values = confirmed.stream().map(Map.Entry::getValue).distinct().limit(2).toList();
        boolean singleValue = values.size() == 1 && confirmed.size() == offers.size();
        if (singleValue && os == null) {
            String summary = "По каталогу для «" + product + "» " + facet.label + " — " + values.getFirst() + ".";
            return offerReply("answer", summary,
                    confirmed.stream().limit(3).map(Map.Entry::getKey).toList());
        }

        String subject = first(os, facet.search);
        if (facet != Facet.PRICE) {
            List<Knowledge> articles = catalog.productKnowledge(product, subject);
            if (!articles.isEmpty()) return knowledgeReply(articles.subList(0, 1));
        }
        if (os == null && !values.isEmpty()) {
            return offerReply("insufficient_data", "Для «" + product + "» данные по полю «" + facet.label
                    + "» зависят от позиции или заполнены частично. Уточните редакцию или артикул.",
                    confirmed.stream().limit(3).map(Map.Entry::getKey).toList());
        }
        String field = os == null ? facet.missing : "совместимость с " + os;
        return offerReply("insufficient_data", "Для «" + product + "» в текущем каталоге и справке не удалось подтвердить "
                + field + ". Если знаете редакцию или артикул, укажите их для проверки.",
                offers.stream().limit(3).toList());
    }

    Reply plan(Turn turn, MlClient.Interpretation input, Map<String, Object> requirements) {
        String product = query(requirements.get("product_name"));
        String useCase = query(requirements.get("use_case"));
        String modelQuery = query(input.productQuery());
        boolean known = "known_product".equals(input.intent()) && (product != null || modelQuery != null || useCase == null);
        String search = known ? first(product, modelQuery) : first(useCase, modelQuery);
        if (search == null) return Reply.text("clarify", QUESTIONS.get(known ? "product_name" : "use_case"));

        ProductMatch match = known ? resolveProduct(turn.catalogVersion(), search) : null;
        List<Offer> found = known ? match.offers() : catalog.find(turn.catalogVersion(), search, true);
        if (found.isEmpty()) {
            if (known && CatalogSearch.mentions(turn.userText(), search)
                    && CommercialRequest.wantsOrder(FaqText.key(turn.userText()))) return offCatalog();
            return Reply.text("insufficient_data", "Подходящую позицию в текущем каталоге подтвердить не удалось. "
                    + "Уточните параметры или артикул, если он известен.");
        }

        Map<String, Object> filters = new LinkedHashMap<>(requirements);
        if (known && match.edition() != null) filters.putIfAbsent("edition", match.edition());
        List<Candidate> candidates = found.stream()
                .filter(CatalogSearch::canRecommend)
                .map(offer -> new Candidate(offer, unmet(offer, filters))).filter(candidate -> candidate.missing() != null)
                .toList();
        List<Offer> confirmed = candidates.stream().filter(candidate -> candidate.missing().isEmpty())
                .map(Candidate::offer).limit(3).toList();
        if (!confirmed.isEmpty()) {
            String field = clarification(input, filters, candidates, known, useCase);
            if (field != null) return Reply.text("clarify", QUESTIONS.get(field));
            return offerReply("recommend", recommendation(confirmed, known ? match.family() : null), confirmed);
        }
        if (candidates.isEmpty()) {
            String target = known ? " семейства «" + match.family() + "»" : "";
            return Reply.text("insufficient_data", "В каталоге есть позиции" + target
                    + ", но подтверждённые характеристики не совпадают со всеми требованиями. Уточните параметры или артикул.");
        }

        List<Candidate> partial = candidates.stream().sorted(Comparator.comparingInt(c -> c.missing().size()))
                .limit(3).toList();
        var missing = new LinkedHashSet<String>();
        partial.forEach(candidate -> missing.addAll(candidate.missing()));
        String target = known ? " семейства «" + match.family() + "»" : " по описанной задаче";
        String labels = missing.stream().map(field -> "edition".equals(field) && filters.containsKey(field)
                ? "редакцию «" + filters.get(field) + "»" : FIELD_LABELS.get(field))
                .collect(Collectors.joining(", "));
        String conditions = known ? confirmedConditions(partial.getFirst(), filters) : "";
        return offerReply("insufficient_data", "Нашёл в каталоге позиции" + target + ". " + conditions
                + "По карточкам пока не удалось подтвердить " + labels + ". Если знаете артикул, напишите его.",
                partial.stream().map(Candidate::offer).toList());
    }

    private static String confirmedConditions(Candidate candidate, Map<String, Object> filters) {
        Offer offer = candidate.offer();
        List<String> details = new ArrayList<>();
        if (filters.containsKey("license_kind") && !candidate.missing().contains("license_kind")) {
            details.add("renewal".equals(offer.licenseKind()) ? "продление" : "новая лицензия");
        }
        if (filters.containsKey("seats") && !candidate.missing().contains("seats")) {
            details.add(offer.seats() + " польз.");
        }
        if (filters.containsKey("license_term_months") && !candidate.missing().contains("license_term_months")) {
            details.add(offer.term() + " мес.");
        }
        return details.isEmpty() ? "" : "В первой карточке подтверждены " + String.join(", ", details) + ". ";
    }

    private static String clarification(MlClient.Interpretation input, Map<String, Object> filters,
                                        List<Candidate> candidates, boolean known, String useCase) {
        for (String field : input.clarificationCandidates()) {
            if (field == null || !QUESTIONS.containsKey(field) || filters.containsKey(field)) continue;
            if (!known && useCase != null && List.of("product_name", "edition").contains(field)) continue;
            if (candidates.stream().map(candidate -> attribute(candidate.offer(), field))
                    .filter(Objects::nonNull).distinct().limit(2).count() == 2) return field;
        }
        return null;
    }

    private ProductMatch resolveProduct(UUID version, String query) {
        if (query == null) return new ProductMatch(null, null, List.of());
        List<Offer> exact = catalog.findProduct(version, query);
        if (!exact.isEmpty()) return new ProductMatch(query, null, exact);
        int split = query.lastIndexOf(' ');
        for (int attempts = 0; split > 0 && attempts < 2; attempts++) {
            String family = query.substring(0, split).stripTrailing();
            List<Offer> related = catalog.findProduct(version, family);
            if (!related.isEmpty()) return new ProductMatch(family, query.substring(split + 1).strip(), related);
            split = family.lastIndexOf(' ');
        }
        return new ProductMatch(query, null, List.of());
    }

    private static Reply offCatalog() {
        return Reply.handoff("off_catalog_order", "Передали запрос менеджеру, чтобы проверить возможность поставки. "
                + "Если знаете производителя или артикул, напишите их здесь.");
    }

    private Reply knowledgeReply(List<Knowledge> articles) {
        List<Fact> facts = new ArrayList<>();
        List<JsonNode> sources = new ArrayList<>();
        for (Knowledge article : articles) {
            facts.add(new Fact("f" + (facts.size() + 1), "По справке «" + article.title() + "»: " + article.text().strip()));
            sources.add(catalog.source(article));
        }
        return new Reply("answer", facts, List.of(), sources);
    }

    private Reply offerReply(String outcome, String text, List<Offer> offers) {
        return new Reply(outcome, List.of(new Fact("f1", text)), offers.stream().map(catalog::card).toList(),
                offers.stream().map(catalog::source).toList());
    }

    private static String recommendation(List<Offer> offers, String family) {
        String product = family == null ? "" : " для «" + family + "»";
        if (offers.size() == 1) return "Нашёл подходящую позицию" + product + ". Проверьте условия в карточке.";
        List<String> differences = new ArrayList<>();
        if (varies(offers, Offer::term)) differences.add("срок");
        if (varies(offers, Offer::licenseKind)) differences.add("тип лицензии");
        if (varies(offers, Facet.PRICE::value)) differences.add("цена");
        String detail = differences.isEmpty() ? "" : " Различаются " + String.join(", ", differences) + ".";
        return "Нашёл подходящие варианты" + product + "." + detail + " Сравните условия в карточках.";
    }

    private static boolean varies(List<Offer> offers, Function<Offer, ?> attribute) {
        return offers.stream().map(attribute).filter(Objects::nonNull).distinct().limit(2).count() == 2;
    }

    private static List<String> unmet(Offer offer, Map<String, Object> requirements) {
        List<String> missing = new ArrayList<>();
        for (var requirement : requirements.entrySet()) {
            String field = requirement.getKey();
            if (!FIELD_LABELS.containsKey(field)) continue;
            Match result = compare(offer, field, requirement.getValue());
            if (result == Match.CONFLICT) return null;
            if (result == Match.UNKNOWN) missing.add(field);
        }
        return missing;
    }

    private static Match compare(Offer offer, String field, Object wanted) {
        if ("edition".equals(field)) return editionMatch(offer, wanted.toString());
        if ("domestic_required".equals(field)) {
            return Boolean.TRUE.equals(wanted) && (offer.registryNumber() == null || !offer.registryNumber().matches("[0-9]+"))
                    ? Match.UNKNOWN : Match.CONFIRMED;
        }
        if ("budget_rub".equals(field)) {
            if (offer.price() == null || offer.price().signum() <= 0
                    || !List.of("RUB", "RUR").contains(Objects.toString(offer.currency(), ""))) return Match.UNKNOWN;
            return offer.price().compareTo(new BigDecimal(wanted.toString())) <= 0 ? Match.CONFIRMED : Match.CONFLICT;
        }
        Object actual = attribute(offer, field);
        if (actual == null) return Match.UNKNOWN;
        boolean matches = switch (field) {
            case "seats" -> ((Number) actual).intValue() >= ((Number) wanted).intValue();
            case "license_term_months", "license_kind" -> wanted.equals(actual);
            case "deployment" -> CatalogSearch.mentions(deployment(actual.toString()), deployment(wanted.toString()));
            default -> CatalogSearch.mentions(platform(actual.toString()), platform(wanted.toString()));
        };
        return matches ? Match.CONFIRMED : Match.CONFLICT;
    }

    private static Match editionMatch(Offer offer, String edition) {
        String actual = productEdition(offer);
        if (actual == null) {
            return CatalogSearch.mentions(offer.name(), edition) ? Match.CONFIRMED : Match.UNKNOWN;
        }
        return CatalogSearch.mentions(actual, edition) ? Match.CONFIRMED : Match.CONFLICT;
    }

    private static String productEdition(Offer offer) {
        // The feed also uses «Версия» for license terms, which cannot establish a product edition.
        String version = offer.edition();
        return version == null || LICENSE_VERSION.matcher(normalize(version)).matches() ? null : version;
    }

    private static Object attribute(Offer offer, String field) {
        return switch (field) {
            case "edition" -> productEdition(offer);
            case "license_kind" -> offer.licenseKind();
            case "seats" -> offer.seats();
            case "license_term_months" -> offer.term();
            case "platform" -> offer.platform();
            case "deployment" -> offer.deployment();
            case "domestic_required" -> offer.registryNumber();
            case "budget_rub" -> offer.price();
            default -> null;
        };
    }

    private static String deployment(String value) {
        return normalize(value).replaceAll("(?U)\\b(?:локальн[а-я]*|на сво[её]м сервере|on[ _-]prem(?:ises)?)\\b", "on_prem")
                .replaceAll("(?U)\\b(?:облачн[а-я]*|(?:в )?облаке|cloud|saas)\\b", "cloud");
    }

    private static String platform(String value) {
        return normalize(value).replaceAll("(?U)\\b(?:mac os(?: x)?|os x|macos)\\b", "macos");
    }

    private static String platformIn(String text) {
        List<String> platforms = OS.matcher(text).results()
                .map(match -> platform(match.group())).distinct().limit(2).toList();
        if (platforms.size() != 1) return null;
        return switch (platforms.getFirst()) {
            case "linux" -> "Linux";
            case "windows" -> "Windows";
            case "macos" -> "macOS";
            case "android" -> "Android";
            case "ios" -> "iOS";
            default -> "Astra Linux";
        };
    }

    private enum Match { CONFIRMED, UNKNOWN, CONFLICT }

    private record Candidate(Offer offer, List<String> missing) {}
    private record ProductMatch(String family, String edition, List<Offer> offers) {}

    private enum Facet {
        PLATFORM("совместимые платформы", "операционную систему", "совместимость OR платформы OR операционная система OR Linux OR Windows OR macOS",
                "(?:ос|операционн[а-я]+ систем[а-я]*|платформ[а-я]*|linux|windows|macos|mac os|android|ios|совместим[а-я]*)"),
        DEPLOYMENT("развёртывание", "способ развёртывания", "развертывание OR облако OR сервер OR локально",
                "(?:развертыван[а-я]*|облачн[а-я]*|облаке|локальн[а-я]*|своем сервере|on prem|cloud)"),
        LICENSE_TERM("срок лицензии", "срок лицензии", "срок лицензии OR действует",
                "(?:срок[а-я]* лиценз[а-я]*|сколько действует)"),
        LICENSE("лицензия", "тип или срок лицензии", "условия лицензии OR срок лицензии OR продление",
                "(?:тип лиценз[а-я]*|лицензирован[а-я]*|продл[а-я]*|лицензи[а-я]*)"),
        PRICE("цена", "цену", "цена", "(?:цен[а-я]*|стоимост[а-я]*|сколько стоит)");

        private final String label;
        private final String missing;
        private final String search;
        private final Pattern terms;

        Facet(String label, String missing, String search, String terms) {
            this.label = label;
            this.missing = missing;
            this.search = search;
            this.terms = Pattern.compile("(?U)\\b" + terms + "\\b");
        }

        static Facet in(String text) {
            for (Facet facet : List.of(PRICE, PLATFORM, DEPLOYMENT, LICENSE_TERM, LICENSE)) {
                if (facet.terms.matcher(text).find()) return facet;
            }
            return null;
        }

        String value(Offer offer) {
            return switch (this) {
                case PLATFORM -> offer.platform();
                case DEPLOYMENT -> offer.deployment();
                case LICENSE_TERM -> offer.term() == null ? null : offer.term() + " мес.";
                case PRICE -> offer.price() == null || offer.price().signum() <= 0 || offer.currency() == null ? null
                        : offer.price().stripTrailingZeros().toPlainString() + " "
                        + ("RUR".equals(offer.currency()) ? "RUB" : offer.currency());
                case LICENSE -> {
                    String kind = switch (Objects.toString(offer.licenseKind(), "")) {
                        case "new" -> "новая лицензия";
                        case "renewal" -> "продление";
                        default -> null;
                    };
                    if (offer.term() == null) yield kind;
                    yield kind == null ? offer.term() + " мес." : kind + ", " + offer.term() + " мес.";
                }
            };
        }
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
            case "deployment" -> value.isTextual() && query(value.textValue()) != null
                    ? deployment(value.textValue()) : null;
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
