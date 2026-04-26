ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

UPDATE questions
SET created_at = NOW()
WHERE created_at IS NULL;

ALTER TABLE questions
  ALTER COLUMN created_at SET DEFAULT NOW();

ALTER TABLE questions
  ALTER COLUMN created_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_questions_created_at ON questions (created_at);

INSERT INTO app_settings (key, value)
VALUES
  ('cleanup_auto_delete_enabled', '0'),
  ('cleanup_deletion_threshold_days', '30'),
  ('cleanup_last_run_date', '')
ON CONFLICT (key) DO NOTHING;
