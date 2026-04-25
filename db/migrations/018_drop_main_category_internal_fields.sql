-- إزالة حقول الوصف/المستوى من التصنيف الرئيسي (تُبقى فقط على الفرعي).
-- آمن عند إعادة التشغيل: قد لا تكون الأعمدة موجودة بعد تعديل 017.
ALTER TABLE question_main_categories DROP CONSTRAINT IF EXISTS chk_qmc_difficulty_level;
ALTER TABLE question_main_categories DROP COLUMN IF EXISTS internal_description;
ALTER TABLE question_main_categories DROP COLUMN IF EXISTS difficulty_level;
