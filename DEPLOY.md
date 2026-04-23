# نشر «فاهم» على Render

## المتطلبات

- مستودع GitHub مربوط بـ Render.
- قاعدة بيانات PostgreSQL على Render (أو أي مزوّد متوافق).

## خطوات سريعة

1. أنشئ **PostgreSQL** على Render واحفظ `Internal Database URL` (أو External إن لزم).
2. أنشئ **Web Service** من نفس المستودع:
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
3. أضف متغيرات البيئة في الخدمة:
   - `DATABASE_URL`: الصق رابط الاتصال بقاعدة البيانات.
   - `NODE_ENV`: `production`
   - `CLIENT_ORIGIN`: رابط موقعك العام على Render (مثل `https://fahem.onrender.com`) ليعمل CORS بشكل صحيح.
4. بعد أول نشر، نفّذ الترحيل والبذر (مرة واحدة) من shell Render أو من جهازك مع نفس `DATABASE_URL`:
   - `npm run db:migrate`
   - `npm run db:seed`
5. **Health Check** في لوحة Render: المسار `/health`.

## ملاحظات

- الخادم يقدّم الواجهة من `client/dist` في وضع الإنتاج.
- Socket.io يعمل على نفس المنفذ والمسار الافتراضي `/socket.io`.
