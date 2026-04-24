CREATE TABLE IF NOT EXISTS question_study_cards (
  id SERIAL PRIMARY KEY,
  question_id INT NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_question_study_cards_question
  ON question_study_cards (question_id, sort_order);
