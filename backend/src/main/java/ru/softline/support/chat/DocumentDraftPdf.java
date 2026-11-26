package ru.softline.support.chat;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.font.PDType0Font;
import org.springframework.stereotype.Component;
import ru.softline.support.chat.ChatTypes.DocumentDraft;
import ru.softline.support.chat.ChatTypes.DraftKind;

@Component
class DocumentDraftPdf {
    private static final float MARGIN = 48;
    private static final float TOP = PDRectangle.A4.getHeight() - MARGIN;
    private static final float WIDTH = PDRectangle.A4.getWidth() - 2 * MARGIN;
    private static final DateTimeFormatter DATE = DateTimeFormatter.ofPattern("dd.MM.uuuu");
    private static final ZoneId MOSCOW = ZoneId.of("Europe/Moscow");

    byte[] render(DocumentDraft draft, DraftKind kind) throws IOException {
        try (PDDocument document = new PDDocument();
             InputStream fontFile = DocumentDraftPdf.class.getResourceAsStream("/fonts/DejaVuSans.ttf")) {
            if (fontFile == null) throw new IOException("Document font unavailable");
            PDType0Font font = PDType0Font.load(document, fontFile);
            document.getDocumentInformation().setTitle(kind.title + " — черновик");
            List<Line> lines = new ArrayList<>();
            add(lines, font, "ЧЕРНОВИК", 14, 12);
            add(lines, font, kind.title, 22, 18);
            add(lines, font, "Заказчик: " + draft.customerName(), 12, 5);
            add(lines, font, "Дата: " + LocalDate.now(MOSCOW).format(DATE), 12, 24);
            add(lines, font, "Каталожная позиция", 15, 7);
            add(lines, font, draft.name(), 12, 6);
            if (!draft.vendorCode().isBlank()) add(lines, font, "Артикул: " + draft.vendorCode(), 12, 6);
            add(lines, font, "Количество позиций: " + draft.quantity(), 12, 6);
            add(lines, font, "Цена за позицию: " + money(draft.unitPrice(), draft.currency()), 12, 10);
            add(lines, font, "Итого: " + money(draft.total(), draft.currency()), 16, 22);
            add(lines, font, kind.note, 11, 4);
            writePages(document, font, lines);
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            document.save(output);
            return output.toByteArray();
        }
    }

    private static String money(BigDecimal amount, String currency) {
        return amount.stripTrailingZeros().toPlainString().replace('.', ',') + " " + currency;
    }

    private static void add(List<Line> lines, PDType0Font font, String text, float size, float gap) throws IOException {
        StringBuilder printable = new StringBuilder(text.length());
        for (int offset = 0; offset < text.length();) {
            int point = text.codePointAt(offset);
            offset += Character.charCount(point);
            if (Character.isWhitespace(point) || Character.isSpaceChar(point) || Character.isISOControl(point)) {
                printable.append(' ');
                continue;
            }
            String glyph = Character.toString(point);
            try {
                font.encode(glyph);
                printable.append(glyph);
            } catch (IllegalArgumentException ex) {
                printable.append('□');
            }
        }

        float maxWidth = WIDTH * 1000 / size;
        float spaceWidth = font.getStringWidth(" ");
        StringBuilder line = new StringBuilder();
        float used = 0;
        for (String word : printable.toString().strip().split(" +")) {
            float wordWidth = font.getStringWidth(word);
            if (!line.isEmpty() && used + spaceWidth + wordWidth > maxWidth) {
                lines.add(new Line(line.toString(), size, 0));
                line.setLength(0);
                used = 0;
            }
            if (!line.isEmpty()) {
                line.append(' ');
                used += spaceWidth;
            }
            if (wordWidth <= maxWidth) {
                line.append(word);
                used += wordWidth;
                continue;
            }
            for (int offset = 0; offset < word.length();) {
                int point = word.codePointAt(offset);
                offset += Character.charCount(point);
                String glyph = Character.toString(point);
                float glyphWidth = font.getStringWidth(glyph);
                if (used + glyphWidth > maxWidth) {
                    lines.add(new Line(line.toString(), size, 0));
                    line.setLength(0);
                    used = 0;
                }
                line.append(glyph);
                used += glyphWidth;
            }
        }
        lines.add(new Line(line.toString(), size, gap));
    }

    private static void writePages(PDDocument doc, PDType0Font font, List<Line> lines) throws IOException {
        int nextLine = 0;
        while (nextLine < lines.size()) {
            PDPage page = new PDPage(PDRectangle.A4);
            doc.addPage(page);
            try (PDPageContentStream stream = new PDPageContentStream(doc, page)) {
                float y = TOP;
                while (nextLine < lines.size()) {
                    Line line = lines.get(nextLine);
                    if (y - line.size() < MARGIN) break;
                    y -= line.size();
                    stream.beginText();
                    stream.setFont(font, line.size());
                    stream.newLineAtOffset(MARGIN, y);
                    stream.showText(line.text());
                    stream.endText();
                    y -= 5 + line.gap();
                    nextLine++;
                }
            }
        }
    }

    private record Line(String text, float size, float gap) {}
}
