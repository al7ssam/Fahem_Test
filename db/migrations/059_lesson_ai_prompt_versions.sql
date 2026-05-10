-- لقطات إعداد برومبت درس AI (للمراجعة والرجوع عن الخطأ).
CREATE TABLE IF NOT EXISTS public.lesson_ai_prompt_versions (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL,
  note TEXT
);

CREATE INDEX IF NOT EXISTS lesson_ai_prompt_versions_created_at_idx
  ON public.lesson_ai_prompt_versions (created_at DESC);
