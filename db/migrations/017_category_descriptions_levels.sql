ALTER TABLE question_main_categories
  ADD COLUMN IF NOT EXISTS internal_description TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS difficulty_level TEXT NOT NULL DEFAULT 'intermediate';

ALTER TABLE question_subcategories
  ADD COLUMN IF NOT EXISTS internal_description TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS difficulty_level TEXT NOT NULL DEFAULT 'intermediate';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_qmc_difficulty_level'
      AND conrelid = 'question_main_categories'::regclass
  ) THEN
    ALTER TABLE question_main_categories
      ADD CONSTRAINT chk_qmc_difficulty_level
      CHECK (difficulty_level IN ('beginner', 'intermediate', 'advanced'));
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_qsc_difficulty_level'
      AND conrelid = 'question_subcategories'::regclass
  ) THEN
    ALTER TABLE question_subcategories
      ADD CONSTRAINT chk_qsc_difficulty_level
      CHECK (difficulty_level IN ('beginner', 'intermediate', 'advanced'));
  END IF;
END
$$;

UPDATE question_main_categories
SET internal_description = CASE main_key
  WHEN 'math' THEN 'محتوى رياضي يغطي الجبر والحساب والهندسة؛ مخصص لبناء أسئلة وبطاقات مذاكرة في هذا المجال.'
  WHEN 'physics' THEN 'محتوى فيزيائي يغطي الميكانيكا والكهرباء والموجات؛ مخصص لبناء أسئلة وبطاقات مذاكرة في هذا المجال.'
  WHEN 'history' THEN 'محتوى تاريخي يغطي العصور القديمة والإسلامية والحديثة؛ مخصص لبناء أسئلة وبطاقات مذاكرة في هذا المجال.'
  WHEN 'english' THEN 'محتوى لغة إنجليزية يغطي المفردات والقواعد والقراءة؛ مخصص لبناء أسئلة وبطاقات مذاكرة في هذا المجال.'
  WHEN 'islamic_culture' THEN 'محتوى ثقافة إسلامية يغطي القرآن والحديث والفقه؛ مخصص لبناء أسئلة وبطاقات مذاكرة في هذا المجال.'
  WHEN 'arabic' THEN 'محتوى لغة عربية يغطي النحو والأدب والبلاغة؛ مخصص لبناء أسئلة وبطاقات مذاكرة في هذا المجال.'
  WHEN 'general_culture' THEN 'محتوى ثقافة عامة يغطي الجغرافيا والعلوم والرياضة ومواضيع متنوعة؛ مخصص لبناء أسئلة وبطاقات مذاكرة في هذا المجال.'
  WHEN 'programming' THEN 'محتوى برمجة يغطي الأساسيات والويب والخوارزميات؛ مخصص لبناء أسئلة وبطاقات مذاكرة في هذا المجال.'
  ELSE internal_description
END
WHERE main_key IN (
  'math', 'physics', 'history', 'english', 'islamic_culture',
  'arabic', 'general_culture', 'programming'
)
AND btrim(internal_description) = '';
