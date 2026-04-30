-- Token usage + estimated USD per simple_content run (Gemini API usageMetadata).

ALTER TABLE simple_content_runs
  ADD COLUMN IF NOT EXISTS usage_input_tokens INT,
  ADD COLUMN IF NOT EXISTS usage_output_tokens INT,
  ADD COLUMN IF NOT EXISTS usage_total_tokens INT,
  ADD COLUMN IF NOT EXISTS estimated_cost_usd NUMERIC(14, 8);
