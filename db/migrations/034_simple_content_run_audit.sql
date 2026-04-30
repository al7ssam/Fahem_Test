-- Audit fields + pending_review for manual preview-then-commit flow.

ALTER TABLE simple_content_runs
  ADD COLUMN IF NOT EXISTS request_prompt TEXT,
  ADD COLUMN IF NOT EXISTS model_response TEXT,
  ADD COLUMN IF NOT EXISTS normalized_questions JSONB;

ALTER TABLE simple_content_runs DROP CONSTRAINT IF EXISTS chk_simple_content_runs_status;
ALTER TABLE simple_content_runs ADD CONSTRAINT chk_simple_content_runs_status
  CHECK (status IN ('running', 'pending_review', 'succeeded', 'failed'));
