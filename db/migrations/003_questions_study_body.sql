ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS study_body TEXT NULL;

UPDATE questions q
SET study_body = sub.body
FROM (
  SELECT DISTINCT ON (question_id) question_id, body
  FROM question_study_cards
  ORDER BY question_id, sort_order ASC, id ASC
) AS sub
WHERE q.id = sub.question_id
  AND (q.study_body IS NULL OR btrim(q.study_body) = '');
