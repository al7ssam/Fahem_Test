CREATE TABLE IF NOT EXISTS ai_factory_model_config (
  id BIGSERIAL PRIMARY KEY,
  layer_name TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'gemini',
  model_name TEXT NOT NULL,
  api_key_env TEXT NOT NULL,
  temperature DOUBLE PRECISION NOT NULL DEFAULT 0.4,
  max_output_tokens INT NOT NULL DEFAULT 4096,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_ai_factory_model_config_layer CHECK (
    layer_name IN ('architect', 'creator', 'auditor', 'refiner')
  ),
  CONSTRAINT chk_ai_factory_model_config_tokens CHECK (max_output_tokens >= 256 AND max_output_tokens <= 65536),
  CONSTRAINT chk_ai_factory_model_config_temp CHECK (temperature >= 0 AND temperature <= 2)
);

INSERT INTO ai_factory_model_config (layer_name, provider, model_name, api_key_env, temperature, max_output_tokens, is_enabled)
VALUES
  ('architect', 'gemini', 'gemini-1.5-pro', 'GEMINI_API_KEY', 0.4, 4096, TRUE),
  ('creator', 'gemini', 'gemini-1.5-pro', 'GEMINI_API_KEY', 0.7, 8192, TRUE),
  ('auditor', 'gemini', 'gemini-1.5-pro', 'GEMINI_API_KEY', 0.2, 8192, TRUE),
  ('refiner', 'gemini', 'gemini-1.5-pro', 'GEMINI_API_KEY', 0.3, 8192, TRUE)
ON CONFLICT (layer_name) DO NOTHING;

CREATE TABLE IF NOT EXISTS ai_factory_jobs (
  id BIGSERIAL PRIMARY KEY,
  subcategory_key TEXT NOT NULL,
  difficulty_mode TEXT NOT NULL DEFAULT 'mix',
  target_count INT NOT NULL,
  batch_size INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  current_layer TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 4,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_ai_factory_jobs_status CHECK (
    status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')
  ),
  CONSTRAINT chk_ai_factory_jobs_layer CHECK (
    current_layer IS NULL OR current_layer IN ('architect', 'creator', 'auditor', 'refiner')
  ),
  CONSTRAINT chk_ai_factory_jobs_attempts CHECK (attempt_count >= 0 AND max_attempts >= 1),
  CONSTRAINT chk_ai_factory_jobs_size CHECK (batch_size >= 1 AND batch_size <= 200),
  CONSTRAINT chk_ai_factory_jobs_target CHECK (target_count >= 1 AND target_count <= 100000)
);

CREATE INDEX IF NOT EXISTS idx_ai_factory_jobs_status_next
  ON ai_factory_jobs (status, next_run_at, id);

CREATE INDEX IF NOT EXISTS idx_ai_factory_jobs_subcategory_created
  ON ai_factory_jobs (subcategory_key, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_factory_job_logs (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES ai_factory_jobs(id) ON DELETE CASCADE,
  layer_name TEXT,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_ai_factory_job_logs_level CHECK (level IN ('debug', 'info', 'warn', 'error')),
  CONSTRAINT chk_ai_factory_job_logs_layer CHECK (
    layer_name IS NULL OR layer_name IN ('architect', 'creator', 'auditor', 'refiner')
  )
);

CREATE INDEX IF NOT EXISTS idx_ai_factory_job_logs_job_created
  ON ai_factory_job_logs (job_id, created_at);

CREATE TABLE IF NOT EXISTS ai_factory_pipeline_state (
  subcategory_key TEXT PRIMARY KEY,
  target_count INT NOT NULL DEFAULT 200,
  generated_count INT NOT NULL DEFAULT 0,
  last_job_id BIGINT REFERENCES ai_factory_jobs(id) ON DELETE SET NULL,
  last_status TEXT NOT NULL DEFAULT 'idle',
  last_layer TEXT,
  last_run_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_ai_factory_pipeline_state_last_status CHECK (
    last_status IN ('idle', 'running', 'succeeded', 'failed')
  ),
  CONSTRAINT chk_ai_factory_pipeline_state_counts CHECK (target_count >= 1 AND generated_count >= 0)
);

INSERT INTO app_settings (key, value)
VALUES
  ('ai_factory_enabled', '0'),
  ('ai_factory_batch_size', '20'),
  ('ai_factory_interval_minutes', '30'),
  ('ai_factory_default_target_count', '200'),
  ('ai_factory_last_scheduler_run', '')
ON CONFLICT (key) DO NOTHING;
