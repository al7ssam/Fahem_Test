-- أسئلة مملوكة لدرس محدد (إنشاء من صفحة إدارة الدروس)

ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS lesson_id INT NULL REFERENCES lessons (id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_questions_lesson_id
  ON questions (lesson_id)
  WHERE lesson_id IS NOT NULL;
