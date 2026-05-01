-- Lesson sections: group items into study+quiz rounds per section

CREATE TABLE IF NOT EXISTS lesson_sections (
  id SERIAL PRIMARY KEY,
  lesson_id INT NOT NULL REFERENCES lessons (id) ON DELETE CASCADE,
  sort_order INT NOT NULL CHECK (sort_order >= 0),
  title_ar TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (lesson_id, sort_order)
);

CREATE INDEX IF NOT EXISTS idx_lesson_sections_lesson_sort
  ON lesson_sections (lesson_id, sort_order);

ALTER TABLE lesson_items
  ADD COLUMN IF NOT EXISTS lesson_section_id INT REFERENCES lesson_sections (id) ON DELETE CASCADE;

-- One default section per lesson that already has items (sort_order = 0)
INSERT INTO lesson_sections (lesson_id, sort_order, title_ar)
SELECT l.id, 0, NULL
FROM lessons l
WHERE EXISTS (SELECT 1 FROM lesson_items li WHERE li.lesson_id = l.id)
  AND NOT EXISTS (SELECT 1 FROM lesson_sections ls WHERE ls.lesson_id = l.id);

UPDATE lesson_items li
SET lesson_section_id = ls.id
FROM lesson_sections ls
WHERE ls.lesson_id = li.lesson_id
  AND ls.sort_order = 0
  AND li.lesson_section_id IS NULL;

-- ترتيب العناصر أصبح لكل قسم؛ إزالة القيد القديم على (lesson_id, sort_order)
ALTER TABLE lesson_items DROP CONSTRAINT IF EXISTS lesson_items_lesson_id_sort_order_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_lesson_items_section_sort
  ON lesson_items (lesson_section_id, sort_order);

-- Require section for every item once backfilled
ALTER TABLE lesson_items
  ALTER COLUMN lesson_section_id SET NOT NULL;
