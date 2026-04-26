-- إزالة مستوى الصعوبة من التصنيف الفرعي (الصعوبة تُدار على مستوى السؤال نفسه).
ALTER TABLE question_subcategories
  DROP CONSTRAINT IF EXISTS chk_qsc_difficulty_level;

ALTER TABLE question_subcategories
  DROP COLUMN IF EXISTS difficulty_level;

-- فهارس لتحسين فلترة الأسئلة حسب الصعوبة.
CREATE INDEX IF NOT EXISTS idx_questions_difficulty
  ON questions (difficulty);

CREATE INDEX IF NOT EXISTS idx_questions_subcategory_difficulty
  ON questions (subcategory_key, difficulty);
