DO $$
DECLARE
  old_constraint_name text;
BEGIN
  SELECT conname
  INTO old_constraint_name
  FROM pg_constraint
  WHERE conrelid = 'questions'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%correct_index >= 0%'
    AND pg_get_constraintdef(oid) LIKE '%correct_index <= 3%';

  IF old_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE questions DROP CONSTRAINT %I', old_constraint_name);
  END IF;
END $$;

ALTER TABLE questions
  DROP CONSTRAINT IF EXISTS chk_questions_options_count_and_correct_index;

ALTER TABLE questions
  ADD CONSTRAINT chk_questions_options_count_and_correct_index
  CHECK (
    jsonb_typeof(options) = 'array'
    AND jsonb_array_length(options) IN (2, 4)
    AND correct_index >= 0
    AND correct_index < jsonb_array_length(options)
  );
