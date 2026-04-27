ALTER TABLE ai_factory_jobs
  ADD COLUMN IF NOT EXISTS final_output_json JSONB;
