-- دروس مخصصة محفوظة للمستخدم (JSON يطابق استيراد الدرس)

CREATE TABLE IF NOT EXISTS public.user_saved_lessons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  payload JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_saved_lessons_user_expires
  ON public.user_saved_lessons (user_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_saved_lessons_expires_at
  ON public.user_saved_lessons (expires_at);
