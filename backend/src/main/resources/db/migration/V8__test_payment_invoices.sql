CREATE SEQUENCE support_test_invoice_number;

ALTER TABLE quote_drafts
    ADD COLUMN invoice_number text UNIQUE,
    ADD CONSTRAINT quote_drafts_invoice_number_requires_pdf
        CHECK (invoice_number IS NULL OR invoice_pdf IS NOT NULL);
