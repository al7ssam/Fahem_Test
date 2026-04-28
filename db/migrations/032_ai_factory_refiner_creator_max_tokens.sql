-- Raise output caps for large Arabic batches + optional thinking tokens (refiner patches still preferred).
UPDATE ai_factory_model_config
SET
  max_output_tokens = LEAST(65536, GREATEST(max_output_tokens, 16384)),
  updated_at = NOW()
WHERE layer_name = 'refiner';

UPDATE ai_factory_model_config
SET
  max_output_tokens = LEAST(65536, GREATEST(max_output_tokens, 12288)),
  updated_at = NOW()
WHERE layer_name = 'creator';
