package ru.softline.support.chat;

import java.io.IOException;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.font.PDType0Font;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;
import ru.softline.support.chat.ChatTypes.DocumentDraft;

final class CommercialProposalPdf {
    private static final float LEFT = 36;
    private static final float RIGHT = PDRectangle.A4.getWidth() - LEFT;
    private static final float[] COLUMNS = {63, 205, 35, 70, 71, 79};
    private static final float TABLE_FONT = 9;
    private static final float ROW_LINE_HEIGHT = 12;
    private static final int ITEM_LINES_PER_PAGE = 24;

    private CommercialProposalPdf() {}

    static void write(PDDocument document, PDType0Font font, DocumentDraft draft, UUID quoteId, String date)
            throws IOException {
        PDImageXObject logo = DocumentDraftPdf.image(document, "/quote/softline-logo.png");
        PDImageXObject footer = DocumentDraftPdf.image(document, "/quote/softline-footer.png");
        String currency = "RUB".equals(draft.currency()) ? "руб." : draft.currency();
        List<List<String>> labels = cells(font, "Артикул", "Наименование", "Кол-во",
                "Цена, " + currency, "Сумма, " + currency, "В т. ч. НДС, " + currency);
        List<List<String>> item = cells(font, draft.vendorCode().isBlank() ? "—" : draft.vendorCode(),
                draft.name(), Integer.toString(draft.quantity()), amount(draft.discountedUnitPrice()),
                amount(draft.total()), "Уточняется");
        List<List<String>> total = cells(font, "", "Итого", "", "", amount(draft.total()), "Уточняется");
        int itemLines = linesIn(item);
        for (int offset = 0; offset < itemLines; offset += ITEM_LINES_PER_PAGE) {
            int count = Math.min(ITEM_LINES_PER_PAGE, itemLines - offset);
            PDPage page = new PDPage(PDRectangle.A4);
            document.addPage(page);
            try (PDPageContentStream stream = new PDPageContentStream(document, page)) {
                writeHeader(stream, font, logo, draft.customerName(), quoteId, date);
                text(stream, font, "Уважаемый заказчик!", 10, LEFT, 635, RIGHT - LEFT, true);
                text(stream, font, "ПАО «Софтлайн» предлагает Вашему вниманию коммерческое предложение на следующих условиях:",
                        9, LEFT, 611, RIGHT - LEFT, true);

                float y = row(stream, font, labels, 596, 0, linesIn(labels), true);
                y = row(stream, font, item, y, offset, count, false);
                if (offset + count == itemLines) {
                    y = row(stream, font, total, y, 0, linesIn(total), false);
                    if (draft.discountPercent().signum() > 0) {
                        text(stream, font, "Базовая сумма: " + amount(draft.originalTotal()) + " " + currency
                                + " · Скидка: " + amount(draft.discountPercent()) + "%", 9, 78, y - 15, 450, false);
                        y -= 18;
                    }
                    writeTerms(stream, font, y - 22);
                }
                drawArtwork(stream, footer, (PDRectangle.A4.getWidth() - 378) / 2, 22, 378);
            }
        }
    }

    private static void writeHeader(PDPageContentStream stream, PDType0Font font, PDImageXObject logo,
                                    String customer, UUID quoteId, String date) throws IOException {
        drawArtwork(stream, logo, 48, 772, 138);
        String[] contacts = {
            "119021, город Москва, ул. Льва Толстого, д. 5, стр. 1,",
            "этаж 3, помещ. 1, ком. № 2, 2а (а-311)",
            "+7 495 232 00 23 | info@softline.com",
            "www.softline.ru | www.softline.com",
        };
        float y = 749;
        for (String line : contacts) {
            text(stream, font, line, 8, 48, y, 255, false);
            y -= 14;
        }
        y = 782;
        String[] recipient = {"Куда: " + customer, "Исх. № б/н от " + date, "Идентификатор КП: " + quoteId};
        for (String field : recipient) {
            for (String line : DocumentDraftPdf.wrap(font, field, 9, 230)) {
                float lineWidth = font.getStringWidth(line) * 9 / 1000;
                text(stream, font, line, 9, RIGHT - lineWidth, y, lineWidth, false);
                y -= 13;
            }
            y -= 7;
        }
    }

    private static void writeTerms(PDPageContentStream stream, PDType0Font font, float y) throws IOException {
        text(stream, font, "Условия предложения", 10, 78, y, 450, false);
        String[] terms = {
            "НДС: уточняет менеджер.",
            "Условия оплаты: уточняет менеджер.",
            "Срок поставки: уточняет менеджер.",
            "Срок действия коммерческого предложения: уточняет менеджер.",
        };
        for (String term : terms) {
            y -= 14;
            text(stream, font, term, 9, 78, y, 450, false);
        }
    }

    private static List<List<String>> cells(PDType0Font font, String... values) throws IOException {
        List<List<String>> cells = new ArrayList<>();
        for (int i = 0; i < values.length; i++) {
            cells.add(DocumentDraftPdf.wrap(font, values[i], TABLE_FONT, COLUMNS[i] - 10));
        }
        return cells;
    }

    private static int linesIn(List<List<String>> cells) {
        return cells.stream().mapToInt(List::size).max().orElseThrow();
    }

    private static float row(PDPageContentStream stream, PDType0Font font, List<List<String>> cells,
                             float top, int offset, int count, boolean header) throws IOException {
        float height = count * ROW_LINE_HEIGHT + 10;
        float x = LEFT;
        stream.setLineWidth(0.6f);
        for (int i = 0; i < cells.size(); i++) {
            float width = COLUMNS[i];
            stream.addRect(x, top - height, width, height);
            stream.stroke();
            List<String> lines = cells.get(i);
            for (int j = offset; j < Math.min(offset + count, lines.size()); j++) {
                text(stream, font, lines.get(j), TABLE_FONT, x + 5, top - 14 - (j - offset) * ROW_LINE_HEIGHT,
                        width - 10, header || i == 2);
            }
            x += width;
        }
        return top - height;
    }

    private static void text(PDPageContentStream stream, PDType0Font font, String value, float size,
                             float x, float y, float width, boolean center) throws IOException {
        float left = center ? x + (width - font.getStringWidth(value) * size / 1000) / 2 : x;
        stream.beginText();
        stream.setFont(font, size);
        stream.newLineAtOffset(left, y);
        stream.showText(value);
        stream.endText();
    }

    private static void drawArtwork(PDPageContentStream stream, PDImageXObject image, float x, float y,
                                    float width) throws IOException {
        stream.drawImage(image, x, y, width, width * image.getHeight() / image.getWidth());
    }

    private static String amount(BigDecimal value) {
        return value.stripTrailingZeros().toPlainString().replace('.', ',');
    }
}
