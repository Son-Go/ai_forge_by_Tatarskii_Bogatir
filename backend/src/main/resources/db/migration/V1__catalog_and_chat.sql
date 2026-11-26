CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE catalog_imports (
    import_id uuid PRIMARY KEY,
    source text NOT NULL,
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    etag text,
    last_modified text,
    snapshot_at timestamptz,
    activated_at timestamptz,
    status text NOT NULL CHECK (status IN ('loading', 'validated', 'activated', 'failed')),
    added_count integer NOT NULL DEFAULT 0 CHECK (added_count >= 0),
    changed_count integer NOT NULL DEFAULT 0 CHECK (changed_count >= 0),
    removed_count integer NOT NULL DEFAULT 0 CHECK (removed_count >= 0),
    validation_report jsonb
);

CREATE TABLE catalog_sync_runs (
    run_id uuid PRIMARY KEY,
    scheduled_date date NOT NULL,
    attempt integer NOT NULL CHECK (attempt > 0),
    source text NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    status text NOT NULL CHECK (status IN ('running', 'unchanged', 'activated', 'failed')),
    http_status integer,
    error_code text,
    import_id uuid REFERENCES catalog_imports (import_id),
    UNIQUE (scheduled_date, attempt)
);

CREATE TABLE catalog_head (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    active_import_id uuid NOT NULL REFERENCES catalog_imports (import_id)
);

CREATE TABLE catalog_categories (
    import_id uuid NOT NULL REFERENCES catalog_imports (import_id),
    category_id text NOT NULL,
    parent_id text,
    name text NOT NULL,
    path text,
    PRIMARY KEY (import_id, category_id),
    FOREIGN KEY (import_id, parent_id)
        REFERENCES catalog_categories (import_id, category_id)
);

CREATE TABLE catalog_offers (
    import_id uuid NOT NULL REFERENCES catalog_imports (import_id),
    offer_id text NOT NULL,
    group_id text,
    category_id text,
    vendor text,
    vendor_code text,
    name text NOT NULL,
    description text,
    product_url text NOT NULL,
    currency text,
    price numeric CHECK (price >= 0),
    available boolean,
    edition text,
    license_kind text CHECK (license_kind IN ('new', 'renewal')),
    seats integer CHECK (seats > 0),
    license_term_months integer CHECK (license_term_months > 0),
    updates_term_months integer CHECK (updates_term_months > 0),
    support_term_months integer CHECK (support_term_months > 0),
    deployment text,
    platform text,
    registry_number text,
    raw_attributes jsonb NOT NULL DEFAULT '{}',
    PRIMARY KEY (import_id, offer_id),
    FOREIGN KEY (import_id, category_id)
        REFERENCES catalog_categories (import_id, category_id)
);

CREATE INDEX catalog_offers_vendor_code_idx
    ON catalog_offers (import_id, lower(vendor_code)) WHERE vendor_code IS NOT NULL;
CREATE INDEX catalog_offers_category_idx ON catalog_offers (import_id, category_id);
CREATE INDEX catalog_offers_group_idx ON catalog_offers (import_id, group_id);
CREATE INDEX catalog_offers_name_trgm_idx ON catalog_offers USING gin (lower(name) gin_trgm_ops);
CREATE INDEX catalog_offers_search_idx ON catalog_offers USING gin
    (to_tsvector('russian', coalesce(name, '') || ' ' || coalesce(description, '')));

CREATE TABLE knowledge_documents (
    document_id uuid PRIMARY KEY,
    source_url text NOT NULL,
    title text NOT NULL,
    fetched_at timestamptz NOT NULL,
    content_hash text NOT NULL,
    version text NOT NULL,
    UNIQUE (source_url, version)
);

CREATE TABLE knowledge_chunks (
    chunk_id uuid PRIMARY KEY,
    document_id uuid NOT NULL REFERENCES knowledge_documents (document_id),
    section text,
    body text NOT NULL
);

CREATE INDEX knowledge_chunks_search_idx ON knowledge_chunks USING gin
    (to_tsvector('russian', body));

CREATE TABLE chat_sessions (
    session_id uuid PRIMARY KEY,
    token_hash text NOT NULL,
    requirements jsonb NOT NULL DEFAULT '{}',
    selected_import_id uuid REFERENCES catalog_imports (import_id),
    selected_offer_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((selected_import_id IS NULL) = (selected_offer_id IS NULL))
);

CREATE TABLE chat_messages (
    message_id uuid PRIMARY KEY,
    session_id uuid NOT NULL REFERENCES chat_sessions (session_id),
    turn_id uuid UNIQUE,
    role text NOT NULL CHECK (role IN ('user', 'assistant')),
    body text NOT NULL,
    status text NOT NULL CHECK (status IN ('streaming', 'complete', 'partial')),
    last_seq integer NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
    cards jsonb NOT NULL DEFAULT '[]',
    sources jsonb NOT NULL DEFAULT '[]',
    created_at timestamptz NOT NULL DEFAULT now(),
    ordinal bigint GENERATED ALWAYS AS IDENTITY,
    UNIQUE (session_id, message_id),
    CHECK ((role = 'user' AND turn_id IS NULL AND status = 'complete')
        OR (role = 'assistant' AND turn_id IS NOT NULL))
);

CREATE INDEX chat_messages_history_idx ON chat_messages (session_id, ordinal);

CREATE TABLE chat_turns (
    turn_id uuid PRIMARY KEY,
    session_id uuid NOT NULL REFERENCES chat_sessions (session_id),
    client_message_id uuid NOT NULL,
    request_id text NOT NULL,
    user_message_id uuid NOT NULL,
    catalog_import_id uuid NOT NULL REFERENCES catalog_imports (import_id),
    status text NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
    deadline_at timestamptz NOT NULL,
    outcome text CHECK (outcome IN ('clarify', 'recommend', 'answer', 'insufficient_data')),
    error_code text,
    model_version text,
    prompt_version text,
    retry_of_turn_id uuid,
    UNIQUE (session_id, turn_id),
    UNIQUE (session_id, client_message_id),
    FOREIGN KEY (session_id, user_message_id) REFERENCES chat_messages (session_id, message_id),
    FOREIGN KEY (session_id, retry_of_turn_id) REFERENCES chat_turns (session_id, turn_id)
);

CREATE UNIQUE INDEX chat_turns_one_running_idx ON chat_turns (session_id) WHERE status = 'running';

ALTER TABLE chat_messages ADD FOREIGN KEY (session_id, turn_id)
    REFERENCES chat_turns (session_id, turn_id);
