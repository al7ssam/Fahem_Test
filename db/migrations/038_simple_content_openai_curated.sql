-- Curated OpenAI presets for simple-content (text only, focused set).
-- Source models guidance: https://platform.openai.com/docs/models

INSERT INTO simple_content_model_presets (provider, model_id, label_ar, max_output_tokens, temperature, api_key_env, sort_order, is_active)
SELECT
  v.provider,
  v.model_id,
  v.label_ar,
  v.max_output_tokens,
  v.temperature,
  v.api_key_env,
  v.sort_order,
  v.is_active
FROM (
  VALUES
    ('openai'::text, 'gpt-5.5'::text, 'OpenAI جودة عالية — gpt-5.5'::text, 16384, 0.45::double precision, 'OPENAI_API_KEY'::text, 100, true),
    ('openai'::text, 'gpt-5.4-mini'::text, 'OpenAI متوازن — gpt-5.4-mini'::text, 12288, 0.55::double precision, 'OPENAI_API_KEY'::text, 110, true),
    ('openai'::text, 'gpt-5.4-nano'::text, 'OpenAI سريع/اقتصادي — gpt-5.4-nano'::text, 8192, 0.6::double precision, 'OPENAI_API_KEY'::text, 120, true)
) AS v(provider, model_id, label_ar, max_output_tokens, temperature, api_key_env, sort_order, is_active)
WHERE NOT EXISTS (
  SELECT 1 FROM simple_content_model_presets p
  WHERE p.provider = v.provider AND p.model_id = v.model_id
);

UPDATE simple_content_model_presets
SET
  label_ar = CASE model_id
    WHEN 'gpt-5.5' THEN 'OpenAI جودة عالية — gpt-5.5'
    WHEN 'gpt-5.4-mini' THEN 'OpenAI متوازن — gpt-5.4-mini'
    WHEN 'gpt-5.4-nano' THEN 'OpenAI سريع/اقتصادي — gpt-5.4-nano'
    ELSE label_ar
  END,
  max_output_tokens = CASE model_id
    WHEN 'gpt-5.5' THEN 16384
    WHEN 'gpt-5.4-mini' THEN 12288
    WHEN 'gpt-5.4-nano' THEN 8192
    ELSE max_output_tokens
  END,
  temperature = CASE model_id
    WHEN 'gpt-5.5' THEN 0.45::double precision
    WHEN 'gpt-5.4-mini' THEN 0.55::double precision
    WHEN 'gpt-5.4-nano' THEN 0.6::double precision
    ELSE temperature
  END,
  api_key_env = 'OPENAI_API_KEY',
  sort_order = CASE model_id
    WHEN 'gpt-5.5' THEN 100
    WHEN 'gpt-5.4-mini' THEN 110
    WHEN 'gpt-5.4-nano' THEN 120
    ELSE sort_order
  END,
  is_active = CASE
    WHEN model_id IN ('gpt-5.5', 'gpt-5.4-mini', 'gpt-5.4-nano') THEN true
    ELSE is_active
  END
WHERE provider = 'openai';

UPDATE simple_content_model_presets
SET is_active = FALSE
WHERE provider = 'openai'
  AND model_id NOT IN ('gpt-5.5', 'gpt-5.4-mini', 'gpt-5.4-nano');
