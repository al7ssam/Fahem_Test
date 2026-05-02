-- إزالة عمود زمن بطاقة التعلم الافتراضي للدرس (الاعتماد على study_phase_ms لكل قسم فقط)

ALTER TABLE lessons DROP COLUMN IF EXISTS default_study_card_ms;
