-- تفضيلات مستخدم لمسار «درس مخصص»: معاملات برومبت JSON (nullable = اتباع افتراضيات الموقع)

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS custom_lesson_prompt_params JSONB;
