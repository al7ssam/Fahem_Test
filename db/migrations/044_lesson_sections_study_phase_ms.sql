-- إجمالي زمن طور المذاكرة لكل قسم (بدلاً من study_card_ms لكل عنصر)

ALTER TABLE lesson_sections
  ADD COLUMN IF NOT EXISTS study_phase_ms INTEGER;

ALTER TABLE lesson_sections DROP CONSTRAINT IF EXISTS lesson_sections_study_phase_ms_range;
ALTER TABLE lesson_sections ADD CONSTRAINT lesson_sections_study_phase_ms_range
  CHECK (study_phase_ms IS NULL OR (study_phase_ms >= 2000 AND study_phase_ms <= 300000));

-- تعبئة من منطق المجموع السابق لكل بطاقة مذاكرة في القسم
UPDATE lesson_sections ls
SET study_phase_ms = agg.computed
FROM (
  SELECT
    ls2.id AS sid,
    LEAST(
      300000,
      GREATEST(
        5000,
        CASE
          WHEN COALESCE(sums.sum_ms, 0) > 0 THEN COALESCE(sums.sum_ms, 0)
          ELSE l.default_study_card_ms
        END
      )
    )::INTEGER AS computed
  FROM lesson_sections ls2
  JOIN lessons l ON l.id = ls2.lesson_id
  LEFT JOIN LATERAL (
    SELECT SUM(
             CASE
               WHEN q.study_body IS NOT NULL AND btrim(q.study_body) <> ''
               THEN COALESCE(li.study_card_ms, l.default_study_card_ms)
               ELSE 0
             END
           ) AS sum_ms
    FROM lesson_items li
    JOIN questions q ON q.id = li.question_id
    WHERE li.lesson_section_id = ls2.id
  ) sums ON TRUE
) agg
WHERE ls.id = agg.sid AND ls.study_phase_ms IS NULL;
