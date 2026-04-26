UPDATE ai_factory_model_config
SET
  model_name = 'gemini-3-flash-preview',
  api_key_env = 'GEMINI_API_KEY',
  updated_at = NOW()
WHERE layer_name IN ('architect', 'creator', 'auditor', 'refiner');
