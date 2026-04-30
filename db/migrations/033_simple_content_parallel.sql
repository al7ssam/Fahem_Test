-- Parallel "simple path" content generation (single prompt per subcategory). Independent from ai_factory_*.

CREATE TABLE IF NOT EXISTS simple_content_model_presets (
  id SERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  label_ar TEXT NOT NULL,
  max_output_tokens INT NOT NULL DEFAULT 8192,
  temperature DOUBLE PRECISION NOT NULL DEFAULT 0.55,
  api_key_env TEXT NOT NULL DEFAULT 'GEMINI_API_KEY',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_simple_content_presets_provider CHECK (provider IN ('gemini', 'openai')),
  CONSTRAINT chk_simple_content_presets_tokens CHECK (max_output_tokens >= 256 AND max_output_tokens <= 65536),
  CONSTRAINT chk_simple_content_presets_temp CHECK (temperature >= 0 AND temperature <= 2)
);

INSERT INTO simple_content_model_presets (provider, model_id, label_ar, max_output_tokens, temperature, api_key_env, sort_order)
SELECT v.* FROM (
  VALUES
    ('gemini'::text, 'gemini-2.5-flash'::text, 'سريع ومتوازن (موصى به)'::text, 8192, 0.55::double precision, 'GEMINI_API_KEY'::text, 10),
    ('gemini', 'gemini-2.5-pro', 'أعلى جودة (أبطأ وأغلى)', 8192, 0.45, 'GEMINI_API_KEY', 20),
    ('gemini', 'gemini-3-flash-preview', 'Gemini 3 Flash', 12288, 0.5, 'GEMINI_API_KEY', 30),
    ('openai', 'gpt-4o-mini', 'OpenAI (قريباً)', 4096, 0.5, 'OPENAI_API_KEY', 100)
) AS v(provider, model_id, label_ar, max_output_tokens, temperature, api_key_env, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM simple_content_model_presets p
  WHERE p.provider = v.provider AND p.model_id = v.model_id
);

UPDATE simple_content_model_presets SET is_active = FALSE WHERE provider = 'openai';

CREATE TABLE IF NOT EXISTS simple_content_prompts (
  subcategory_key TEXT PRIMARY KEY REFERENCES question_subcategories (subcategory_key) ON DELETE CASCADE,
  prompt_body TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS simple_content_automation (
  subcategory_key TEXT PRIMARY KEY REFERENCES question_subcategories (subcategory_key) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  interval_minutes INT NOT NULL DEFAULT 60,
  model_preset_id INT REFERENCES simple_content_model_presets (id) ON DELETE SET NULL,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_simple_content_auto_interval CHECK (interval_minutes >= 5 AND interval_minutes <= 10080)
);

CREATE TABLE IF NOT EXISTS simple_content_runs (
  id BIGSERIAL PRIMARY KEY,
  subcategory_key TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT,
  model_id TEXT,
  preset_id INT REFERENCES simple_content_model_presets (id) ON DELETE SET NULL,
  inserted_count INT NOT NULL DEFAULT 0,
  error TEXT,
  preview_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  CONSTRAINT chk_simple_content_runs_trigger CHECK (trigger_kind IN ('manual', 'scheduled')),
  CONSTRAINT chk_simple_content_runs_status CHECK (status IN ('running', 'succeeded', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_simple_content_runs_sub_created
  ON simple_content_runs (subcategory_key, created_at DESC);
