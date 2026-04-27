ALTER TABLE ai_factory_jobs
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS worker_id TEXT;

UPDATE ai_factory_jobs
SET heartbeat_at = COALESCE(heartbeat_at, started_at, updated_at, created_at)
WHERE heartbeat_at IS NULL;

ALTER TABLE ai_factory_jobs
  DROP CONSTRAINT IF EXISTS chk_ai_factory_jobs_layer;

ALTER TABLE ai_factory_jobs
  ADD CONSTRAINT chk_ai_factory_jobs_layer CHECK (
    current_layer IS NULL OR current_layer IN ('creator', 'gate', 'architect', 'auditor', 'refiner')
  );

ALTER TABLE ai_factory_job_logs
  DROP CONSTRAINT IF EXISTS chk_ai_factory_job_logs_layer;

ALTER TABLE ai_factory_job_logs
  ADD CONSTRAINT chk_ai_factory_job_logs_layer CHECK (
    layer_name IS NULL OR layer_name IN ('creator', 'gate', 'architect', 'auditor', 'refiner')
  );

ALTER TABLE ai_factory_inspection_logs
  DROP CONSTRAINT IF EXISTS chk_ai_factory_inspection_layer;

ALTER TABLE ai_factory_inspection_logs
  ADD CONSTRAINT chk_ai_factory_inspection_layer CHECK (
    layer_name IN ('creator', 'gate', 'architect', 'auditor', 'refiner')
  );

ALTER TABLE ai_factory_pipeline_state
  DROP CONSTRAINT IF EXISTS chk_ai_factory_pipeline_state_last_status;

ALTER TABLE ai_factory_pipeline_state
  ADD CONSTRAINT chk_ai_factory_pipeline_state_last_status CHECK (
    last_status IN ('idle', 'running', 'succeeded', 'failed', 'cancelled')
  );

CREATE INDEX IF NOT EXISTS idx_ai_factory_jobs_running_heartbeat
  ON ai_factory_jobs (status, heartbeat_at, updated_at)
  WHERE status = 'running';
