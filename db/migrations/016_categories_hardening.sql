DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_qmc_main_key_not_blank'
      AND conrelid = 'question_main_categories'::regclass
  ) THEN
    ALTER TABLE question_main_categories
      ADD CONSTRAINT chk_qmc_main_key_not_blank CHECK (btrim(main_key) <> '');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_qmc_name_ar_not_blank'
      AND conrelid = 'question_main_categories'::regclass
  ) THEN
    ALTER TABLE question_main_categories
      ADD CONSTRAINT chk_qmc_name_ar_not_blank CHECK (btrim(name_ar) <> '');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_qsc_sub_key_not_blank'
      AND conrelid = 'question_subcategories'::regclass
  ) THEN
    ALTER TABLE question_subcategories
      ADD CONSTRAINT chk_qsc_sub_key_not_blank CHECK (btrim(subcategory_key) <> '');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_qsc_name_ar_not_blank'
      AND conrelid = 'question_subcategories'::regclass
  ) THEN
    ALTER TABLE question_subcategories
      ADD CONSTRAINT chk_qsc_name_ar_not_blank CHECK (btrim(name_ar) <> '');
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_qmc_sort_active
  ON question_main_categories (sort_order, is_active, id);

CREATE INDEX IF NOT EXISTS idx_qsc_main_sort_active
  ON question_subcategories (main_category_id, sort_order, is_active, id);

CREATE INDEX IF NOT EXISTS idx_qmc_main_key_lower
  ON question_main_categories ((lower(main_key)));

CREATE INDEX IF NOT EXISTS idx_qsc_sub_key_lower
  ON question_subcategories ((lower(subcategory_key)));
