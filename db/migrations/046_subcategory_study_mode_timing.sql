-- أوقات اختيارية لنمط المذاكرة ثم الأسئلة لكل تصنيف فرعي (NULL = استخدام الإعدادات العامة)
ALTER TABLE question_subcategories
  ADD COLUMN IF NOT EXISTS study_mode_question_ms INTEGER NULL,
  ADD COLUMN IF NOT EXISTS study_mode_study_phase_ms INTEGER NULL;

COMMENT ON COLUMN question_subcategories.study_mode_question_ms IS 'زمن السؤال بالمللي ثانية لنمط study_then_quiz؛ NULL للافتراضي العام';
COMMENT ON COLUMN question_subcategories.study_mode_study_phase_ms IS 'زمن بطاقة المذاكرة بالمللي ثانية لنمط study_then_quiz؛ NULL للافتراضي العام';
