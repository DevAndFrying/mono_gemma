CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS saved_chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  model TEXT,
  messages JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS top_asked_questions (
  normalized_question TEXT PRIMARY KEY,
  display_question TEXT NOT NULL,
  ask_count INTEGER NOT NULL DEFAULT 1,
  first_asked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_asked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS top_asked_questions_count_idx
ON top_asked_questions (ask_count DESC, last_asked_at DESC);
