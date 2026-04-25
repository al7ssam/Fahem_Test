-- وصف داخلي ومستوى صعوبة للتصنيف الفرعي فقط (لا يُضاف للرئيسي).

ALTER TABLE question_subcategories
  ADD COLUMN IF NOT EXISTS internal_description TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS difficulty_level TEXT NOT NULL DEFAULT 'intermediate';

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
