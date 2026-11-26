CREATE TABLE chat_handoffs (
    handoff_id uuid PRIMARY KEY,
    session_id uuid NOT NULL REFERENCES chat_sessions (session_id),
    opening_turn_id uuid NOT NULL,
    reason text NOT NULL CHECK (reason IN ('document_review', 'off_catalog_order')),
    status text NOT NULL CHECK (status IN ('queued', 'in_progress', 'resolved')),
    manager_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    closed_at_ordinal bigint,
    UNIQUE (session_id, handoff_id),
    FOREIGN KEY (session_id, opening_turn_id) REFERENCES chat_turns (session_id, turn_id),
    CHECK ((status = 'queued') = (manager_id IS NULL)),
    CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
    CHECK ((status = 'resolved') = (closed_at_ordinal IS NOT NULL))
);

CREATE UNIQUE INDEX chat_handoffs_active_idx ON chat_handoffs (session_id) WHERE status <> 'resolved';
CREATE INDEX chat_handoffs_session_history_idx ON chat_handoffs (session_id, created_at DESC);
CREATE INDEX chat_handoffs_queue_idx ON chat_handoffs (status, created_at);
CREATE INDEX chat_handoffs_manager_idx ON chat_handoffs (manager_id, created_at);

ALTER TABLE chat_messages DROP CONSTRAINT chat_messages_check;
ALTER TABLE chat_messages ADD COLUMN handoff_id uuid;
ALTER TABLE chat_messages ADD FOREIGN KEY (session_id, handoff_id) REFERENCES chat_handoffs (session_id, handoff_id);
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_author_check CHECK (
    (role = 'user' AND turn_id IS NULL AND status = 'complete')
    OR (role = 'assistant' AND (turn_id IS NOT NULL OR (handoff_id IS NOT NULL AND status = 'complete')))
);
