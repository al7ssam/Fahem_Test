CREATE TABLE IF NOT EXISTS question_main_categories (
  id SERIAL PRIMARY KEY,
  main_key TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '📚',
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS question_subcategories (
  id SERIAL PRIMARY KEY,
  main_category_id INT NOT NULL REFERENCES question_main_categories(id) ON DELETE CASCADE,
  subcategory_key TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '📘',
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE questions
ADD COLUMN IF NOT EXISTS subcategory_key TEXT;

INSERT INTO question_main_categories (main_key, name_ar, icon, sort_order, is_active)
VALUES
  ('math', 'رياضيات', '➗', 10, TRUE),
  ('physics', 'فيزياء', '⚛️', 20, TRUE),
  ('history', 'تاريخ', '📜', 30, TRUE),
  ('english', 'انجليزي', '🇬🇧', 40, TRUE),
  ('islamic_culture', 'ثقافة اسلامية', '🕌', 50, TRUE),
  ('arabic', 'عربي', '📝', 60, TRUE),
  ('general_culture', 'ثقافة عامة', '🌍', 70, TRUE),
  ('programming', 'برمجة', '💻', 80, TRUE)
ON CONFLICT (main_key) DO NOTHING;

WITH m AS (
  SELECT id, main_key FROM question_main_categories
)
INSERT INTO question_subcategories (main_category_id, subcategory_key, name_ar, icon, sort_order, is_active)
VALUES
  ((SELECT id FROM m WHERE main_key = 'math'), 'math_algebra', 'الجبر', '🧮', 10, TRUE),
  ((SELECT id FROM m WHERE main_key = 'math'), 'math_arithmetic', 'العمليات الحسابية', '➕', 20, TRUE),
  ((SELECT id FROM m WHERE main_key = 'math'), 'math_geometry', 'الأشكال الهندسية', '📐', 30, TRUE),

  ((SELECT id FROM m WHERE main_key = 'physics'), 'physics_mechanics', 'الميكانيكا', '🧲', 10, TRUE),
  ((SELECT id FROM m WHERE main_key = 'physics'), 'physics_electricity', 'الكهرباء', '⚡', 20, TRUE),
  ((SELECT id FROM m WHERE main_key = 'physics'), 'physics_waves', 'الموجات', '〰️', 30, TRUE),

  ((SELECT id FROM m WHERE main_key = 'history'), 'history_ancient', 'التاريخ القديم', '🏺', 10, TRUE),
  ((SELECT id FROM m WHERE main_key = 'history'), 'history_islamic', 'التاريخ الإسلامي', '🕋', 20, TRUE),
  ((SELECT id FROM m WHERE main_key = 'history'), 'history_modern', 'التاريخ الحديث', '🏛️', 30, TRUE),

  ((SELECT id FROM m WHERE main_key = 'english'), 'english_vocab', 'المفردات', '🔤', 10, TRUE),
  ((SELECT id FROM m WHERE main_key = 'english'), 'english_grammar', 'القواعد', '📖', 20, TRUE),
  ((SELECT id FROM m WHERE main_key = 'english'), 'english_reading', 'القراءة', '📘', 30, TRUE),

  ((SELECT id FROM m WHERE main_key = 'islamic_culture'), 'islamic_quran', 'القرآن وعلومه', '📗', 10, TRUE),
  ((SELECT id FROM m WHERE main_key = 'islamic_culture'), 'islamic_hadith', 'الحديث', '📚', 20, TRUE),
  ((SELECT id FROM m WHERE main_key = 'islamic_culture'), 'islamic_fiqh', 'الفقه', '⚖️', 30, TRUE),

  ((SELECT id FROM m WHERE main_key = 'arabic'), 'arabic_grammar', 'النحو', '✍️', 10, TRUE),
  ((SELECT id FROM m WHERE main_key = 'arabic'), 'arabic_literature', 'الأدب', '📙', 20, TRUE),
  ((SELECT id FROM m WHERE main_key = 'arabic'), 'arabic_rhetoric', 'البلاغة', '🗣️', 30, TRUE),

  ((SELECT id FROM m WHERE main_key = 'general_culture'), 'general_geo', 'جغرافيا', '🗺️', 10, TRUE),
  ((SELECT id FROM m WHERE main_key = 'general_culture'), 'general_science', 'علوم عامة', '🔬', 20, TRUE),
  ((SELECT id FROM m WHERE main_key = 'general_culture'), 'general_sports', 'رياضة', '🏅', 30, TRUE),

  ((SELECT id FROM m WHERE main_key = 'programming'), 'programming_basics', 'أساسيات البرمجة', '⌨️', 10, TRUE),
  ((SELECT id FROM m WHERE main_key = 'programming'), 'programming_web', 'برمجة الويب', '🌐', 20, TRUE),
  ((SELECT id FROM m WHERE main_key = 'programming'), 'programming_algorithms', 'الخوارزميات', '🧠', 30, TRUE),

  ((SELECT id FROM m WHERE main_key = 'general_culture'), 'general_default', 'عام', '📚', 1000, TRUE)
ON CONFLICT (subcategory_key) DO NOTHING;

UPDATE questions
SET subcategory_key = 'general_default'
WHERE subcategory_key IS NULL OR btrim(subcategory_key) = '';

ALTER TABLE questions
ALTER COLUMN subcategory_key SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_questions_subcategory_key ON questions (subcategory_key);
CREATE INDEX IF NOT EXISTS idx_questions_subcategory_study ON questions (subcategory_key, id)
WHERE study_body IS NOT NULL AND btrim(study_body) <> '';
