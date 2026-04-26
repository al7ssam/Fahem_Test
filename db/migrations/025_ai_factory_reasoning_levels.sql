ALTER TABLE ai_factory_model_config
ADD COLUMN IF NOT EXISTS reasoning_level TEXT;

UPDATE ai_factory_model_config
SET reasoning_level = 'none'
WHERE reasoning_level IS NULL OR btrim(reasoning_level) = '';

ALTER TABLE ai_factory_model_config
ALTER COLUMN reasoning_level SET DEFAULT 'none';

ALTER TABLE ai_factory_model_config
ALTER COLUMN reasoning_level SET NOT NULL;

ALTER TABLE ai_factory_model_config
DROP CONSTRAINT IF EXISTS chk_ai_factory_model_config_reasoning_level;

ALTER TABLE ai_factory_model_config
ADD CONSTRAINT chk_ai_factory_model_config_reasoning_level
CHECK (reasoning_level IN ('none', 'low', 'medium', 'high'));
