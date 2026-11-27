package ru.softline.support.chat;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.font.PDType0Font;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;
import org.springframework.stereotype.Component;
import ru.softline.support.chat.ChatTypes.DocumentDraft;
import ru.softline.support.chat.ChatTypes.DraftKind;

@Component
class DocumentDraftPdf {
    private static final DateTimeFormatter DATE = DateTimeFormatter.ofPattern("dd.MM.uuuu");
    private static final ZoneId MOSCOW = ZoneId.of("Europe/Moscow");

    byte[] render(DocumentDraft draft, DraftKind kind, UUID quoteId) throws IOException {
        try (PDDocument document = new PDDocument();
             InputStream fontFile = DocumentDraftPdf.class.getResourceAsStream("/fonts/DejaVuSans.ttf")) {
            if (fontFile == null) throw new IOException("Document font unavailable");
            PDType0Font font = PDType0Font.load(document, fontFile);
            document.getDocumentInformation().setTitle(kind.title);
            String date = LocalDate.now(MOSCOW).format(DATE);
            if (kind == DraftKind.QUOTE) CommercialProposalPdf.write(document, font, draft, quoteId, date);
            else InvoicePdf.write(document, font, draft, quoteId, date);
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            document.save(output);
            return output.toByteArray();
        }
    }

    static PDImageXObject image(PDDocument document, String resource) throws IOException {
        try (InputStream input = DocumentDraftPdf.class.getResourceAsStream(resource)) {
            if (input == null) throw new IOException("Missing document artwork: " + resource);
            return PDImageXObject.createFromByteArray(document, input.readAllBytes(), resource);
        }
    }

    static List<String> wrap(PDType0Font font, String text, float size, float width) throws IOException {
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

        float maxWidth = width * 1000 / size;
        float spaceWidth = font.getStringWidth(" ");
        List<String> rows = new ArrayList<>();
        StringBuilder line = new StringBuilder();
        float used = 0;
        for (String word : printable.toString().strip().split(" +")) {
            float wordWidth = font.getStringWidth(word);
            if (!line.isEmpty() && used + spaceWidth + wordWidth > maxWidth) {
                rows.add(line.toString());
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
                    rows.add(line.toString());
                    line.setLength(0);
                    used = 0;
                }
                line.append(glyph);
                used += glyphWidth;
            }
        }
        rows.add(line.toString());
        return rows;
    }
}
