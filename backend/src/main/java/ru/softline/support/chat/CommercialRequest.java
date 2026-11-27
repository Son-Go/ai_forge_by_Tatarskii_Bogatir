package ru.softline.support.chat;

import java.util.regex.Pattern;

final class CommercialRequest {
    private static final Pattern DEFERRAL = words("отсроч[а-я]*");
    private static final Pattern PAY_LATER = words(
            "(?:оплатить|заплатить|платить|рассчитаться|оплата) (?:позже|после поставки|через [0-9]+ [а-я]+|до следующ[а-я]+ [а-я]+)");
    private static final Pattern LATER = words("позже|после поставки");
    private static final Pattern DELAY_EVIDENCE = words("отсроч[а-я]*|позже|после поставки|через [0-9]+ [а-я]+|до следующ[а-я]+ [а-я]+");
    private static final Pattern NO_DEFERRAL = words(
            "отсроч[а-я]*(?: (?:нам|мне|больше|сейчас)){0,2} не (?:нужн[аоы]?|требуется|хочу|хотим|надо|интересует)"
            + "|не (?:нужн[аоы]?|надо|просим|прошу|хочу|хотим|рассматрива[а-я]*)(?: (?:нам|мне))? отсроч[а-я]*"
            + "|(?:без|отказываемся от|отказываюсь от) отсроч[а-я]*"
            + "|не (?:хочу|хотим|нужно|надо) (?:оплатить|заплатить|платить|рассчитаться) позже");
    private static final Pattern REQUEST = words(
            "прошу|просим|хочу|хотим|хотел[аи]? бы|дайте|предоставьте|предусмотрите|оформите|нужна|нужны|нужно|можно|можем ли|могу ли");
    private static final Pattern DEFERRAL_ACTION = words(
            "(?:прошу|просим|хочу|хотим|хотел[аи]? бы|дайте|предоставьте|предусмотрите|оформите|нужна|нужно)"
            + "(?: [а-я]+){0,3} отсроч[а-я]*|(?:оплатить|заплатить|рассчитаться) с отсрочк[а-я]*");
    private static final Pattern NEED_DEFERRAL = words("отсроч[а-я]*(?: (?:нам|мне))? нужн[аоы]");
    private static final Pattern INFO = words(
            "услови[а-я]*|правил[а-я]*|как (?:узнать|работает|оформляется|предоставляется)|"
            + "можно ли узнать|можно узнать|расскажите|объясните|какую отсрочку|какая отсрочка");
    private static final Pattern INFO_INTRO = words(
            "как (?:узнать|работает|оформляется)|расскажите|объясните|можно (?:ли )?узнать");
    private static final Pattern CARD_OR_METHOD = words(
            "(?:способ[а-я]*|вариант[а-я]*) оплат[а-я]*|оплатить (?:сразу )?(?:банковской )?картой|"
            + "оплатить по счету|оплата (?:картой|по счету)|как оплатить|сбп|sberpay");
    private static final Pattern OFF_CATALOG = words(
            "(?:вне|за пределами) (?:каталог[а-я]*|витрин[а-я]*)|"
            + "(?:нет|отсутствует|не наш[еа]л[аи]?) (?:в каталоге|на сайте|на витрине)|под заказ");
    private static final Pattern SUPPLY_ACTION = words(
            "(?:проверьте|уточните|подтвердите) (?:возможность )?(?:поставки|поставку|заказа|заказ)");
    private static final Pattern GENERIC_SUPPLY_TARGET = Pattern.compile(
            "(?:пожалуйста )?(?:по|товар[а-я]*|продукт[а-я]*|позици[а-я]*|лицензи[а-я]*)?(?: пожалуйста)?");
    private static final Pattern BUY = words("купить|приобрести|заказать|оформить заказ|оформите заказ|закажите|нужн[аоы]?");
    private static final Pattern ORDER_ACTION = words(
            "(?:хочу|хотим|прошу|просим|нужно|нужен|нужна|помогите) (?:заказать|купить|приобрести)|закажите|оформите заказ");
    private static final Pattern HYPOTHETICAL = words("если|в случае|что делать при");

    private CommercialRequest() {}

    static boolean wantsDeferral(String text, boolean modelConfirmed) {
        if (NO_DEFERRAL.matcher(text).find() || INFO.matcher(text).find() || HYPOTHETICAL.matcher(text).find()) return false;
        if (DEFERRAL.matcher(text).find()) {
            if (CARD_OR_METHOD.matcher(text).find()) return DEFERRAL_ACTION.matcher(text).find();
            return REQUEST.matcher(text).find() || NEED_DEFERRAL.matcher(text).find();
        }
        if (!REQUEST.matcher(text).find() || !PAY_LATER.matcher(text).find()) return false;
        return modelConfirmed || LATER.matcher(text).find();
    }

    static boolean deferralEvidence(String text) {
        return DELAY_EVIDENCE.matcher(text).find();
    }

    static boolean wantsSupplyCheck(String text) {
        return !INFO_INTRO.matcher(text).find() && !HYPOTHETICAL.matcher(text).find()
                && SUPPLY_ACTION.matcher(text).find();
    }

    static boolean namesSupplyTarget(String text) {
        var action = SUPPLY_ACTION.matcher(text);
        return action.find() && !GENERIC_SUPPLY_TARGET.matcher(text.substring(action.end()).strip()).matches();
    }

    static boolean wantsOrder(String text) {
        return !INFO_INTRO.matcher(text).find() && !HYPOTHETICAL.matcher(text).find()
                && BUY.matcher(text).find();
    }

    static boolean hypothetical(String text) {
        return HYPOTHETICAL.matcher(text).find();
    }

    static String guide(String text) {
        if (DEFERRAL.matcher(text).find() && !NO_DEFERRAL.matcher(text).find() && !wantsDeferral(text, false)) {
            return "deferral";
        }
        if (CARD_OR_METHOD.matcher(text).find()) return "payment";
        if (OFF_CATALOG.matcher(text).find()
                && (!ORDER_ACTION.matcher(text).find() || INFO_INTRO.matcher(text).find() || hypothetical(text))) return "off_catalog";
        return null;
    }

    private static Pattern words(String alternatives) {
        return Pattern.compile("(?U)\\b(?:" + alternatives + ")\\b");
    }
}
