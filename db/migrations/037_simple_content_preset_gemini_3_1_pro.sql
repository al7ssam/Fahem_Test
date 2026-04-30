-- Gemini 3.1 Pro (preview) for simple-content dropdowns; aligns with modelManager allowlist.

INSERT INTO simple_content_model_presets (provider, model_id, label_ar, max_output_tokens, temperature, api_key_env, sort_order, is_active)
SELECT
  'gemini',
  'gemini-3.1-pro-preview',
  'Gemini 3.1 Pro — gemini-3.1-pro-preview',
  16384,
  0.45::double precision,
  'GEMINI_API_KEY',
  25,
  true
WHERE NOT EXISTS (
  SELECT 1 FROM simple_content_model_presets p
  WHERE p.provider = 'gemini' AND p.model_id = 'gemini-3.1-pro-preview'
);

UPDATE simple_content_model_presets
SET is_active = FALSE
WHERE provider = 'gemini'
  AND model_id NOT IN (
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-3-flash-preview',
    'gemini-3.1-pro-preview'
  );

UPDATE simple_content_model_presets
SET
  is_active = TRUE,
  label_ar = 'Gemini 3.1 Pro — gemini-3.1-pro-preview',
  max_output_tokens = LEAST(GREATEST(max_output_tokens, 8192), 65536),
  sort_order = 25
WHERE provider = 'gemini' AND model_id = 'gemini-3.1-pro-preview';
