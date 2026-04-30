-- Curated Gemini presets for simple content: text-generation models only, clear Arabic labels with model_id.
-- Does not mirror full AI_FACTORY list; adjust here when product adds/removes defaults.

UPDATE simple_content_model_presets SET is_active = FALSE WHERE provider = 'openai';

UPDATE simple_content_model_presets SET
  label_ar = CASE model_id
    WHEN 'gemini-2.5-flash' THEN 'سريع ومتوازن — gemini-2.5-flash'
    WHEN 'gemini-2.5-pro' THEN 'أعلى جودة — gemini-2.5-pro'
    WHEN 'gemini-3-flash-preview' THEN 'Gemini 3 Flash — gemini-3-flash-preview'
    ELSE label_ar
  END,
  sort_order = CASE model_id
    WHEN 'gemini-2.5-flash' THEN 10
    WHEN 'gemini-2.5-pro' THEN 20
    WHEN 'gemini-3-flash-preview' THEN 30
    ELSE sort_order
  END
WHERE provider = 'gemini';

UPDATE simple_content_model_presets
SET is_active = FALSE
WHERE provider = 'gemini'
  AND model_id NOT IN ('gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-flash-preview');
