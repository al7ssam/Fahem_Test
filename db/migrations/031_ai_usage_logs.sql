CREATE TABLE IF NOT EXISTS ai_usage_logs (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES ai_factory_jobs(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  layer_type TEXT NOT NULL CHECK (layer_type IN ('architect', 'creator', 'auditor', 'refiner')),
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
  cost_sar NUMERIC(12, 6) NOT NULL DEFAULT 0,
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_created_at
  ON ai_usage_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_subject_created
  ON ai_usage_logs (subject, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_model_created
  ON ai_usage_logs (model_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_layer_created
  ON ai_usage_logs (layer_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_subject_model_created
  ON ai_usage_logs (subject, model_id, created_at DESC);
