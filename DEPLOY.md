# نشر «فاهم» على Render

## المتطلبات

- مستودع GitHub مربوط بـ Render.
- قاعدة بيانات PostgreSQL على Render (أو أي مزوّد متوافق).

## خطوات سريعة

1. أنشئ **PostgreSQL** على Render واحفظ `Internal Database URL` (أو External إن لزم).
2. أنشئ **Web Service** من نفس المستودع (Root Directory = جذر المستودع حيث يوجد `package.json`):
   - **Build Command**: `npm install --include=dev && npm run build`  
     (إذا ضبطت `NODE_ENV=production` قبل التثبيت، فبدون `--include=dev` لن يُثبَّت Vite/TypeScript وسيظهر خطأ **127** لأن `vite` أو `tsc` غير موجودين.)
   - **Start Command**: `npm run db:migrate && node dist/server/index.js` (أو `npm start` — نفس السلوك من `package.json`: ترحيل الجدول ثم تشغيل الخادم)
3. أضف متغيرات البيئة في الخدمة:
   - `DATABASE_URL`: الصق رابط الاتصال بقاعدة البيانات.
   - `CLIENT_ORIGIN`: رابط موقعك العام على Render (مثل `https://fahem.onrender.com`) ليعمل CORS بشكل صحيح.
   - `ADMIN_SECRET`: سلسلة عشوائية طويلة؛ تُستخدم في صفحة **`/admin`** (حقل المفتاح) مع رأس `X-Admin-Secret` عند حفظ الأسئلة.
   - `NODE_ENV`: اختياري — Render يضبط الإنتاج عادةً في وقت التشغيل؛ تجنّب جعل التثبيت «production only» بدون تضمين dev إن غيّرت سلوك npm لديك.
4. **ترحيل الجدول:** عند التشغيل يُنفَّذ `npm run db:migrate` تلقائياً قبل الخادم (`npm start` / أمر البدء في Render)، فلا تحتاج Shell لإنشاء جدول `questions`. **البذر** (`npm run db:seed`) ما زال اختيارياً مرة واحدة إن أردت أسئلة تجريبية جاهزة — من Shell أو محلياً مع نفس `DATABASE_URL`.
5. **Health Check** في لوحة Render: المسار `/health`.

## ملاحظات

- الخادم يقدّم الواجهة من `client/dist` في وضع الإنتاج.
- Socket.io يعمل على نفس المنفذ والمسار الافتراضي `/socket.io`.
- إدارة الأسئلة: افتح `https://<اسم-الخدمة>.onrender.com/admin` بعد ضبط `ADMIN_SECRET`؛ تعرض الصفحة **إجمالي عدد الأسئلة** وتحدّثه بعد كل حفظ ناجح.
- استيراد دفعة: من نفس الصفحة يمكن لصق JSON (مصفوفة أو `{ "questions": [...] }`)؛ الحد الأقصى **200** سؤالاً لكل طلب، وحجم جسم الطلب حتى نحو **1 MB** (`express.json`). يمكن تضمين **`studyCards`** داخل كل سؤال: مصفوفة `{ "body": "...", "sort_order": 0 }` (أو `sortOrder`) لإدراج بطاقات `question_study_cards` مع نفس المعاملة.

- نمط «بطاقات ثم أسئلة»: متغيرات اختيارية `STUDY_PHASE_MS`، `STUDY_QUIZ_BLOCK_SIZE`، `MAX_STUDY_CARDS_DISPLAY`، `STUDY_MATCH_PREFETCH` (عدد الأسئلة المُسبَقة لمراجعة واحدة في بداية المباراة)، `MAX_STUDY_CARDS_MATCH_START` (سقف بطاقات تلك المراجعة) — انظر `.env.example`. يتطلب جدول `question_study_cards`.
