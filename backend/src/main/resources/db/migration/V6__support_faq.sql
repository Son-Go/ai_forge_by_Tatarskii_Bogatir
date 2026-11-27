CREATE TABLE support_faq_candidates (
    candidate_id uuid PRIMARY KEY,
    handoff_id uuid NOT NULL UNIQUE REFERENCES chat_handoffs (handoff_id),
    question_message_id uuid REFERENCES chat_messages (message_id),
    answer_message_id uuid NOT NULL REFERENCES chat_messages (message_id),
    status text NOT NULL CHECK (status IN ('queued', 'needs_review', 'case_specific', 'published', 'rejected', 'unpublished')),
    reason_code text,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
    next_check_at timestamptz,
    review_token uuid,
    proposed_question text,
    proposed_answer text,
    proposed_source_id uuid REFERENCES knowledge_chunks (chunk_id),
    prompt_version text,
    model_version text,
    reviewed_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((status = 'queued') = (next_check_at IS NOT NULL)),
    CHECK (review_token IS NULL OR status = 'queued')
);

CREATE INDEX support_faq_candidates_due_idx
    ON support_faq_candidates (next_check_at, candidate_id) WHERE status = 'queued';

CREATE TABLE support_faq (
    candidate_id uuid PRIMARY KEY REFERENCES support_faq_candidates (candidate_id),
    question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 500),
    question_key text NOT NULL CHECK (question_key <> ''),
    answer text NOT NULL CHECK (char_length(answer) BETWEEN 1 AND 2000),
    product text,
    product_key text,
    edition text,
    edition_key text,
    source_id uuid NOT NULL REFERENCES knowledge_chunks (chunk_id),
    status text NOT NULL CHECK (status IN ('published', 'unpublished')),
    approval_method text NOT NULL CHECK (approval_method IN ('automatic', 'manager')),
    approved_by text,
    published_at timestamptz NOT NULL DEFAULT now(),
    unpublished_at timestamptz,
    CHECK ((product IS NULL) = (product_key IS NULL)),
    CHECK ((edition IS NULL) = (edition_key IS NULL)),
    CHECK (edition IS NULL OR product IS NOT NULL),
    CHECK ((approval_method = 'manager') = (approved_by IS NOT NULL)),
    CHECK ((status = 'unpublished') = (unpublished_at IS NOT NULL))
);

CREATE UNIQUE INDEX support_faq_published_question_idx ON support_faq
    (question_key, coalesce(product_key, ''), coalesce(edition_key, '')) WHERE status = 'published';
CREATE INDEX support_faq_published_trgm_idx ON support_faq
    USING gin (question_key gin_trgm_ops) WHERE status = 'published';

-- Keep order, negation, numbers and unknown words. Strip only conversational filler
-- before comparing close questions so unrelated uses of the same product stay distinct.
CREATE FUNCTION support_faq_terms(phrase text) RETURNS text[]
    LANGUAGE sql STABLE STRICT PARALLEL SAFE
    RETURN (
        SELECT coalesce(array_agg(coalesce((ts_lexize('pg_catalog.russian_stem', word))[1], word)
                                  ORDER BY pos), ARRAY[]::text[])
        FROM unnest(string_to_array(phrase, ' ')) WITH ORDINALITY AS words(word, pos)
        WHERE word NOT IN ('пожалуйста', 'подскажите', 'скажите', 'здравствуйте', 'добрый', 'день', 'мне')
    );
