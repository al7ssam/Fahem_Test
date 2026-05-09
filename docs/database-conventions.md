# Database Conventions (Deterministic PostgreSQL / Neon pooled)

هذه الوثيقة هي المرجع الرسمي لكتابة SQL والتعامل مع PostgreSQL داخل مشروع `فاهم`.
الهدف هو الوصول إلى سلوك deterministic في كل البيئات، خصوصًا Neon pooled مع PgBouncer.

## 1) SQL Qualification Rules

- أي جدول تطبيقي يجب أن يكتب بصيغة صريحة: `public.table_name`.
- ممنوع الاعتماد على `search_path` الضمني في SQL الجديد أو المعدل.
- ينطبق هذا على:
  - `SELECT ... FROM`
  - `JOIN`
  - `UPDATE`
  - `DELETE FROM`
  - `INSERT INTO`
  - `ALTER TABLE` و`CREATE TABLE` في migrations

أمثلة:

- صحيح:
  - `SELECT key, value FROM public.app_settings WHERE key = $1`
  - `DELETE FROM public.simple_content_runs WHERE id = $1`
  - `INSERT INTO public.simple_content_runs (...) VALUES (...)`
- خاطئ:
  - `SELECT key, value FROM app_settings WHERE key = $1`
  - `DELETE FROM simple_content_runs WHERE id = $1`

## 2) Neon / PgBouncer Compatibility

- المشروع يعتمد pooled connection في Neon.
- في pooled mode لا يجب افتراض ثبات session defaults بين كل الطلبات.
- لذلك deterministic SQL (`public.<table>`) هو الأساس.
- `SET search_path TO public` يستخدم كـ fallback دفاعي فقط في DB layer، وليس كآلية رئيسية.

## 3) Query Standards

- استخدم `public.` دائمًا مع جداول التطبيق.
- عند `JOIN` استخدم alias واضح:
  - `FROM public.questions q`
  - `JOIN public.question_subcategories sc ON ...`
- في `UPDATE` و`DELETE`:
  - وجود `WHERE` واضح إلزامي.
  - لعمليات batch استخدم transaction عند الحاجة.
- في subqueries/CTE:
  - تأهيل كل جدول صريحًا أيضًا.

## 4) Migration Standards

- أي migration جديدة في `db/migrations` يجب أن تكون deterministic.
- استخدم `public.<table>` في DDL/DML.
- لا تعتمد على إعدادات DB خارجة عن الكود (مثل search_path على مستوى السيرفر).
- عند تعديل migration قديمة: لا تعيد كتابة التاريخ؛ عدّل عبر migration جديدة إلا إذا كان التعديل قبل النشر الفعلي.

## 5) Connection Layer Rules

- المصدر الرسمي للاتصال هو `server/db/pool.ts`.
- إعدادات pool يجب أن تبقى متوافقة مع serverless PostgreSQL:
  - `ssl` مفعل للاتصالات غير المحلية.
  - حدود pool/timeouts معرفة.
- Session init policy:
  - `SET search_path TO public` عند connect (fallback فقط).
- أي error على مستوى pool/connect يجب log واضح له (`[db_pool] ...`).

## 6) Production Safety Rules

- Cleanup jobs (مثل `server/services/cleanup.ts`):
  - لا تستخدم implicit table names.
  - أي حذف bulk يجب أن يملك شروط أمان واضحة.
- Destructive queries:
  - تنفيذها داخل transaction عند وجود أكثر من خطوة.
  - تجنب أوامر عامة بلا filter في الإنتاج.
- Admin write routes:
  - يجب أن تبقى deterministic بنفس قواعد schema qualification.

## 7) Future Quality Gates

- استخدم فحص تلقائي:
  - `npm run db:check-schema`
- الفحص يرصد الأنماط الضمنية مثل:
  - `FROM table`
  - `JOIN table`
  - `UPDATE table`
  - `INSERT INTO table`
  - `DELETE FROM table`
- أي فشل في هذا الفحص يجب إصلاحه قبل الدمج.

## 8) Developer Checklist (قبل أي PR فيه SQL)

1. هل كل الجداول مكتوبة `public.<table>`؟
2. هل استعلامات `UPDATE/DELETE` مقيدة بـ `WHERE` مناسب؟
3. هل التغيير متوافق مع Neon pooled (بدون اعتماد على session defaults)؟
4. هل migration الجديدة deterministic؟
5. هل مر `npm run db:check-schema`؟

## Common Pitfalls

- افتراض أن `search_path` سيبقى `public` دائمًا في pooled connections.
- إضافة SQL سريع في route/service بدون schema qualification.
- اعتبار نجاح الاستعلام محليًا دليلًا على نجاحه في production pooled.

---

هذه الوثيقة تعتبر معيار مراجعة رسمي. أي SQL جديد لا يلتزم بها يعد regression معماري.
