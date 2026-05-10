-- أيقونة عرض في مكتبة الدروس المحفوظة (إيموجي/رمز قصير)، NULL = الافتراضي في الواجهة

ALTER TABLE public.user_saved_lessons
  ADD COLUMN IF NOT EXISTS library_icon TEXT NULL;

COMMENT ON COLUMN public.user_saved_lessons.library_icon IS 'رمز قصير للعرض في المكتبة؛ NULL يُعرَض كتاب افتراضياً في العميل';
