ALTER TABLE simple_content_runs
  ADD COLUMN IF NOT EXISTS usage_cached_input_tokens INT,
  ADD COLUMN IF NOT EXISTS pricing_input_per_1m DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS pricing_cached_input_per_1m DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS pricing_output_per_1m DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS pricing_source TEXT;

CREATE TABLE IF NOT EXISTS simple_content_pricing_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_simple_content_pricing_audit_created
  ON simple_content_pricing_audit_logs (created_at DESC);
