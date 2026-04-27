ALTER TABLE questions
ADD COLUMN IF NOT EXISTS question_type TEXT;

UPDATE questions
SET question_type = 'application'
WHERE question_type IS NULL OR btrim(question_type) = '';

ALTER TABLE questions
ALTER COLUMN question_type SET DEFAULT 'application';

ALTER TABLE questions
ALTER COLUMN question_type SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_questions_question_type'
  ) THEN
    ALTER TABLE questions
    ADD CONSTRAINT chk_questions_question_type
    CHECK (question_type IN ('conceptual', 'procedural', 'application'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_questions_question_type
  ON questions (question_type);
