package ru.softline.support.chat;

import java.awt.Color;
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
import ru.softline.support.chat.ChatTypes.DraftKind;

final class InvoicePdf {
    private static final float LEFT = 42;
    private static final float RIGHT = PDRectangle.A4.getWidth() - LEFT;
    private static final float WIDTH = RIGHT - LEFT;
    private static final float TABLE_FONT = 10;
    private static final float LINE_HEIGHT = 14;
    private static final float TABLE_BOTTOM_SPACE = 142;
    private static final float[] COLUMNS = {WIDTH - 230, 52, 87, 91};
    private static final Color INK = new Color(34, 37, 45);
    private static final Color ACCENT = new Color(160, 18, 45);
    private static final Color BORDER = new Color(215, 218, 223);
    private static final Color SHADE = new Color(246, 247, 249);

    private InvoicePdf() {}

    static void write(PDDocument document, PDType0Font font, DocumentDraft draft, UUID quoteId, String date)
            throws IOException {
        PDImageXObject logo = DocumentDraftPdf.image(document, "/quote/softline-logo.png");
        String product = draft.name();
        if (!draft.vendorCode().isBlank()) product += " / Артикул: " + draft.vendorCode();
        String currency = draft.currency();
        List<List<String>> cells = new ArrayList<>();
        String[] values = {product, Integer.toString(draft.quantity()), amount(draft.discountedUnitPrice()), amount(draft.total())};
        for (int i = 0; i < values.length; i++) {
            cells.add(DocumentDraftPdf.wrap(font, values[i], TABLE_FONT, COLUMNS[i] - 16));
        }
        int lines = cells.stream().mapToInt(List::size).max().orElseThrow();
        int offset = 0;
        while (offset < lines) {
            PDPage page = new PDPage(PDRectangle.A4);
            document.addPage(page);
            try (PDPageContentStream stream = new PDPageContentStream(document, page)) {
                float tableTop = writeHeader(stream, font, logo, draft.customerName(), quoteId, date);
                float reserve = TABLE_BOTTOM_SPACE + (draft.discountPercent().signum() > 0 ? 16 : 0);
                int count = Math.min((int) ((tableTop - reserve) / LINE_HEIGHT), lines - offset);
                float bottom = writeItem(stream, font, cells, currency, tableTop, offset, count);
                offset += count;
                if (offset == lines) {
                    if (draft.discountPercent().signum() > 0) {
                        rightText(stream, font, "Базовая сумма: " + amount(draft.originalTotal()) + " "
                                + currency + " · Скидка: " + amount(draft.discountPercent()) + "%", 10, RIGHT, bottom - 15, INK);
                        bottom -= 18;
                    }
                    writeTotal(stream, font, amount(draft.total()) + " " + currency, bottom - 14);
                }
            }
        }
    }

    private static float writeHeader(PDPageContentStream stream, PDType0Font font, PDImageXObject logo,
                                     String customer, UUID quoteId, String date) throws IOException {
        stream.drawImage(logo, LEFT, 768, 139, 139f * logo.getHeight() / logo.getWidth());
        rightText(stream, font, DraftKind.INVOICE.title, 28, RIGHT, 777, INK);
        rightText(stream, font, "Дата выставления: " + date, 10, RIGHT, 752, INK);
        fill(stream, ACCENT, LEFT, 737, WIDTH, 2);
        text(stream, font, "Основание: одобренное КП " + quoteId, 10, LEFT, 714, INK);
        text(stream, font, DraftKind.INVOICE.note, 10, LEFT, 696, ACCENT);

        // Published supplier details: https://store.softline.ru/contacts/
        float customerLeft = LEFT + 286;
        text(stream, font, "Поставщик", 11, LEFT, 658, ACCENT);
        text(stream, font, "ПАО «Софтлайн»", 13, LEFT, 638, INK);
        float y = 619;
        for (String line : DocumentDraftPdf.wrap(font,
                "119021, г. Москва, ул. Льва Толстого, д. 5, стр. 1, этаж 3, помещение 1, комн. № 2, 2а (А-311)",
                10, 258)) {
            text(stream, font, line, 10, LEFT, y, INK);
            y -= LINE_HEIGHT;
        }
        text(stream, font, "ИНН 7736227885   КПП 774950001", 10, LEFT, y, INK);
        text(stream, font, "ОГРН 1027736009333", 10, LEFT, y - LINE_HEIGHT, INK);

        text(stream, font, "Покупатель", 11, customerLeft, 658, ACCENT);
        y = 638;
        for (String line : DocumentDraftPdf.wrap(font, customer, 12, RIGHT - customerLeft)) {
            text(stream, font, line, 12, customerLeft, y, INK);
            y -= LINE_HEIGHT;
        }

        float bankTop = Math.min(548, y);
        fill(stream, SHADE, LEFT, bankTop - 59, WIDTH, 59);
        text(stream, font, "Банковские реквизиты поставщика", 11, LEFT + 12, bankTop - 17, ACCENT);
        text(stream, font, "АО «Альфа-Банк», г. Москва", 10, LEFT + 12, bankTop - 34, INK);
        text(stream, font, "БИК 044525593", 10, LEFT + 12, bankTop - 48, INK);
        text(stream, font, "Р/с 40702810502300000368", 10, customerLeft, bankTop - 34, INK);
        text(stream, font, "К/с 30101810200000000593", 10, customerLeft, bankTop - 48, INK);
        return bankTop - 80;
    }

    private static float writeItem(PDPageContentStream stream, PDType0Font font, List<List<String>> cells,
                                   String currency, float tableTop, int offset, int count) throws IOException {
        float rowTop = tableTop - 27;
        fill(stream, SHADE, LEFT, rowTop, WIDTH, 27);
        fill(stream, BORDER, LEFT, rowTop, WIDTH, 0.6f);
        String[] labels = {"Наименование", "Кол-во", "Цена, " + currency, "Сумма, " + currency};
        float x = LEFT;
        for (int column = 0; column < COLUMNS.length; column++) {
            float end = x + COLUMNS[column] - 8;
            if (column == 0) text(stream, font, labels[column], TABLE_FONT, x + 8, tableTop - 17, INK);
            else rightText(stream, font, labels[column], TABLE_FONT, end, tableTop - 17, INK);
            List<String> columnLines = cells.get(column);
            for (int line = offset; line < Math.min(offset + count, columnLines.size()); line++) {
                float y = rowTop - 17 - (line - offset) * LINE_HEIGHT;
                if (column == 0) text(stream, font, columnLines.get(line), TABLE_FONT, x + 8, y, INK);
                else rightText(stream, font, columnLines.get(line), TABLE_FONT, end, y, INK);
            }
            x += COLUMNS[column];
        }
        float bottom = rowTop - count * LINE_HEIGHT - 15;
        fill(stream, BORDER, LEFT, bottom, WIDTH, 0.6f);
        return bottom;
    }

    private static void writeTotal(PDPageContentStream stream, PDType0Font font, String total, float top)
            throws IOException {
        List<String> lines = DocumentDraftPdf.wrap(font, "Сумма по счёту: " + total, 14, WIDTH - 24);
        float height = 20 + lines.size() * 18;
        fill(stream, SHADE, LEFT, top - height, WIDTH, height);
        float y = top - 23;
        for (String line : lines) {
            rightText(stream, font, line, 14, RIGHT - 12, y, ACCENT);
            y -= 18;
        }
    }

    private static String amount(BigDecimal value) {
        return value.stripTrailingZeros().toPlainString().replace('.', ',');
    }

    private static void fill(PDPageContentStream stream, Color color, float x, float y, float width, float height)
            throws IOException {
        stream.setNonStrokingColor(color);
        stream.addRect(x, y, width, height);
        stream.fill();
    }

    private static void rightText(PDPageContentStream stream, PDType0Font font, String value, float size,
                                  float right, float y, Color color) throws IOException {
        text(stream, font, value, size, right - font.getStringWidth(value) * size / 1000, y, color);
    }

    private static void text(PDPageContentStream stream, PDType0Font font, String value, float size,
                             float x, float y, Color color) throws IOException {
        stream.setNonStrokingColor(color);
        stream.beginText();
        stream.setFont(font, size);
        stream.newLineAtOffset(x, y);
        stream.showText(value);
        stream.endText();
    }
}
