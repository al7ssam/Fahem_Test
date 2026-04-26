-- Align stored model_name values with current Gemini API model IDs
-- (see https://ai.google.dev/gemini-api/docs/models — e.g. Gemini 3 Flash uses gemini-3-flash-preview).

UPDATE ai_factory_model_config
SET
  model_name = 'gemini-3-flash-preview',
  updated_at = NOW()
WHERE model_name = 'gemini-3-flash';

UPDATE ai_factory_model_config
SET
  model_name = 'gemini-2.5-flash',
  updated_at = NOW()
WHERE model_name = 'gemini-1.5-flash';

UPDATE ai_factory_model_config
SET
  model_name = 'gemini-2.5-pro',
  updated_at = NOW()
WHERE model_name = 'gemini-1.5-pro';
