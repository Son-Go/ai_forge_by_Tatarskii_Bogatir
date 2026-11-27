CREATE TABLE quote_drafts (
    quote_id uuid PRIMARY KEY,
    session_id uuid NOT NULL REFERENCES chat_sessions (session_id),
    offer_card jsonb NOT NULL,
    customer_name text NOT NULL,
    quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 99999),
    created_at timestamptz NOT NULL DEFAULT now(),
    approved_at timestamptz,
    invalidated_at timestamptz,
    invoice_pdf bytea,
    CHECK (invoice_pdf IS NULL OR approved_at IS NOT NULL)
);

CREATE UNIQUE INDEX quote_drafts_current_idx ON quote_drafts (session_id)
    WHERE invalidated_at IS NULL;
