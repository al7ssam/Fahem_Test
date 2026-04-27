ALTER TABLE ai_usage_logs
  ADD COLUMN IF NOT EXISTS retry_index INTEGER NOT NULL DEFAULT 0;

ALTER TABLE ai_usage_logs
  ADD COLUMN IF NOT EXISTS attempt_id TEXT;

ALTER TABLE ai_usage_logs
  ADD COLUMN IF NOT EXISTS cost_source TEXT NOT NULL DEFAULT 'estimated'
  CHECK (cost_source IN ('provider_exact', 'estimated'));

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_retry_index
  ON ai_usage_logs (retry_index, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_attempt_id
  ON ai_usage_logs (attempt_id);
