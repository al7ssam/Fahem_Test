CREATE TABLE IF NOT EXISTS ai_factory_inspection_logs (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES ai_factory_jobs(id) ON DELETE CASCADE,
  layer_name TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  raw_response_text TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'gemini',
  model_name TEXT NOT NULL DEFAULT '',
  api_version TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_ai_factory_inspection_layer CHECK (
    layer_name IN ('architect', 'creator', 'auditor', 'refiner')
  )
);

CREATE INDEX IF NOT EXISTS idx_ai_factory_inspection_logs_job_created
  ON ai_factory_inspection_logs (job_id, created_at);

CREATE INDEX IF NOT EXISTS idx_ai_factory_inspection_logs_job_layer
  ON ai_factory_inspection_logs (job_id, layer_name, created_at);
