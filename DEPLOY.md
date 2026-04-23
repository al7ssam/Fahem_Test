# نشر «فاهم» على Render

## المتطلبات

- مستودع GitHub مربوط بـ Render.
- قاعدة بيانات PostgreSQL على Render (أو أي مزوّد متوافق).

## خطوات سريعة

1. أنشئ **PostgreSQL** على Render واحفظ `Internal Database URL` (أو External إن لزم).
2. أنشئ **Web Service** من نفس المستودع (Root Directory = جذر المستودع حيث يوجد `package.json`):
   - **Build Command**: `npm install --include=dev && npm run build`  
     (إذا ضبطت `NODE_ENV=production` قبل التثبيت، فبدون `--include=dev` لن يُثبَّت Vite/TypeScript وسيظهر خطأ **127** لأن `vite` أو `tsc` غير موجودين.)
   - **Start Command**: `node dist/server/index.js` (أو `npm start`)
3. أضف متغيرات البيئة في الخدمة:
   - `DATABASE_URL`: الصق رابط الاتصال بقاعدة البيانات.
   - `CLIENT_ORIGIN`: رابط موقعك العام على Render (مثل `https://fahem.onrender.com`) ليعمل CORS بشكل صحيح.
   - `NODE_ENV`: اختياري — Render يضبط الإنتاج عادةً في وقت التشغيل؛ تجنّب جعل التثبيت «production only» بدون تضمين dev إن غيّرت سلوك npm لديك.
4. بعد أول نشر، نفّذ الترحيل والبذر (مرة واحدة) من shell Render أو من جهازك مع نفس `DATABASE_URL`:
   - `npm run db:migrate`
   - `npm run db:seed`
5. **Health Check** في لوحة Render: المسار `/health`.

## ملاحظات

- الخادم يقدّم الواجهة من `client/dist` في وضع الإنتاج.
- Socket.io يعمل على نفس المنفذ والمسار الافتراضي `/socket.io`.
