-- Lesson Mode: categories, lessons, ordered items referencing question bank

CREATE TABLE IF NOT EXISTS lesson_categories (
  id SERIAL PRIMARY KEY,
  parent_id INT REFERENCES lesson_categories (id) ON DELETE CASCADE,
  name_ar TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '📖',
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lesson_categories_parent_sort
  ON lesson_categories (parent_id, sort_order);

CREATE TABLE IF NOT EXISTS lessons (
  id SERIAL PRIMARY KEY,
  lesson_category_id INT REFERENCES lesson_categories (id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  slug TEXT,
  description TEXT,
  default_answer_ms INT NOT NULL DEFAULT 15000
    CHECK (default_answer_ms >= 3000 AND default_answer_ms <= 120000),
  default_study_card_ms INT NOT NULL DEFAULT 10000
    CHECK (default_study_card_ms >= 2000 AND default_study_card_ms <= 300000),
  is_published BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lessons_slug_unique
  ON lessons (slug)
  WHERE slug IS NOT NULL AND btrim(slug) <> '';

CREATE INDEX IF NOT EXISTS idx_lessons_category_published_sort
  ON lessons (lesson_category_id, is_published, sort_order);

CREATE TABLE IF NOT EXISTS lesson_items (
  id SERIAL PRIMARY KEY,
  lesson_id INT NOT NULL REFERENCES lessons (id) ON DELETE CASCADE,
  question_id INT NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  sort_order INT NOT NULL CHECK (sort_order >= 0),
  answer_ms INT CHECK (answer_ms IS NULL OR (answer_ms >= 3000 AND answer_ms <= 120000)),
  study_card_ms INT CHECK (study_card_ms IS NULL OR (study_card_ms >= 2000 AND study_card_ms <= 300000)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (lesson_id, sort_order),
  UNIQUE (lesson_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_lesson_items_lesson_sort
  ON lesson_items (lesson_id, sort_order);
