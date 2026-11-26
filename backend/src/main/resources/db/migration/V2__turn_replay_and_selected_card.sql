ALTER TABLE chat_turns ADD COLUMN retryable boolean NOT NULL DEFAULT true;
ALTER TABLE chat_sessions ADD COLUMN selected_card jsonb;
