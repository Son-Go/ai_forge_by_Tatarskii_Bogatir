package ru.softline.support.chat;

import java.text.Normalizer;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

final class FaqText {
    private static final Pattern PRIVATE_DATA = Pattern.compile(
            "(?iuU)[\\p{L}\\d._%+-]+@[\\p{L}\\d.-]+|https?://|(?:\\+?\\d[().\\s-]*){7,}"
            + "|(?:инн|кпп|снилс|паспорт|номер заказа|номер счета)\\s*[:№#-]?\\s*[a-zа-я]*\\d"
            + "|[\\p{Cntrl}&&[^\\r\\n\\t]]");
    private static final Pattern CASE_SPECIFIC = Pattern.compile(
            "(?iuU)\\b(?:ваш[а-я]*|вас|вам|у вас|наш[а-я]*|у нас|мо[йиях]|мне)\\s+"
            + "(?:заказ[а-я]*|документ[а-я]*|заявк[а-я]*|сч[её]т[а-я]*|договор[а-я]*|поставк[а-я]*|лицензи[а-я]*)"
            + "|\\b(?:провер[а-я]*|одобр[а-я]*|согласова[а-я]*)\\W+(?:ваш[а-я]*\\W+)?документ[а-я]*"
            + "|\\b(?:документ[а-я]*|заказ[а-я]*|заявк[а-я]*)\\W+(?:проверен[а-я]*|одобрен[а-я]*|согласован[а-я]*|отправлен[а-я]*)"
            + "|\\b(?:по вашему заказу|для вашей компании|вашей организации)\\b");
    private static final Pattern DYNAMIC = Pattern.compile(
            "(?iuU)\\b(?:цен[а-я]*|стоимост[а-я]*|сколько стоит|скидк[а-я]*|наличи[а-я]*|в наличии|"
            + "остат[а-я]*|реквизит[а-я]*|срок[а-я]* поставк[а-я]*|дата поставки|статус[а-я]* заказ[а-я]*|"
            + "поставк[а-я]*|доставк[а-я]*|рубл[а-я]*|руб|rub|usd|eur|₽)\\b");
    private static final Set<String> QUESTION_WORDS = Set.of(
            "как", "что", "где", "ли", "зачем", "почему", "можно", "нужно", "какой", "какая", "какие",
            "пожалуйста", "подскажите", "скажите", "здравствуйте", "добрый", "день", "это", "для", "по",
            "в", "на", "и", "с", "из", "к", "или", "не", "без", "чтобы", "если", "при");

    private FaqText() {}

    static String key(String text) {
        return Normalizer.normalize(text, Normalizer.Form.NFKC).toLowerCase(Locale.ROOT).replace('ё', 'е')
                .replaceAll("[._-](?![\\p{L}\\p{N}])", " ")
                .replaceAll("[^\\p{L}\\p{N}+#._-]+", " ")
                .replaceAll("(?<!\\S)[+#]+(?!\\S)", " ").replaceAll(" +", " ").strip();
    }

    static String clip(String text, int size) {
        if (text.length() <= size) return text;
        return text.substring(0, Character.isHighSurrogate(text.charAt(size - 1)) ? size - 1 : size).strip();
    }

    static boolean privateData(String text) {
        return PRIVATE_DATA.matcher(text).find() || text.codePoints()
                .anyMatch(cp -> Character.getType(cp) == Character.FORMAT);
    }

    static boolean caseSpecific(String text) {
        return CASE_SPECIFIC.matcher(text.replaceAll("\\s+", " ")).find();
    }

    static boolean dynamic(String text) {
        return DYNAMIC.matcher(text.replaceAll("\\s+", " ")).find() || text.indexOf('₽') >= 0;
    }

    static boolean contains(String text, String phrase) {
        return !phrase.isEmpty() && (" " + text + " ").contains(" " + phrase + " ");
    }

    static Set<String> trustedWords(Iterable<String> excerpts) {
        Set<String> words = new HashSet<>(QUESTION_WORDS);
        for (String excerpt : excerpts) words.addAll(Arrays.asList(key(excerpt).split(" ")));
        words.remove("");
        return words;
    }

    // Only send words already present in the public excerpts or in the fixed
    // question vocabulary. Unknown names, identifiers and free-form details stay local.
    static String forReview(String text, Set<String> trusted) {
        return Arrays.stream(key(text).split(" "))
                .map(word -> trusted.contains(word) ? word : "[скрыто]").collect(Collectors.joining(" "));
    }
}
