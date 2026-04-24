# فاهم — Fahem

للتفاصيل الكاملة الخاصة بالنشر راجع الملف:

- [`DEPLOY.md`](DEPLOY.md)

## ملاحظة مهمة قبل النشر

تمت إضافة migration جديدة:

- `db/migrations/006_game_settings.sql`

هذه migration تضيف مفاتيح إعدادات اللعبة الافتراضية داخل `app_settings`:

- `game_max_study_rounds`
- `game_study_round_size`
- `game_study_phase_ms`

تأكد من تشغيل الترحيلات (`npm run db:migrate`) على بيئة النشر قبل تشغيل الخدمة حتى تعمل إعدادات الجولات ونمط المذاكرة من لوحة الإدارة بشكل صحيح.
