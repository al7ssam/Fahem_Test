# Auth Runbook (Firebase + Internal Sessions)

## 1) إعداد Firebase Console

- فعّل Providers: `Google`, `Email/Password`.
- أضف جميع `Authorized Domains` اللازمة (local + production).
- إعادة تعيين كلمة المرور (من التطبيق):
  - يستخدم العميل `sendPasswordResetEmail` مع `handleCodeInApp` ووجهة `VITE_FIREBASE_EMAIL_RESET_CONTINUE_URL`.
  - أضف نطاق الاستضافة الفعلي (مثل `YOUR-APP.onrender.com`) إلى **Authorized domains** في Authentication > Settings.
  - عند الفتح تحتوي الرسالة الفعلية على `mode=resetPassword` و `oobCode` ويُكمِّل SPA المودّال و `confirmPasswordReset`.
- ربط الموفرّين:
  - عند خلط Google وبريد لنفس الطرفية، الواجهة تتبّع `fetchSignInMethodsForEmail` و`linkWithCredential` وبيانات Google المعلقة.
  - للتحقق اليدوي: أنشئ حسابًا عبر Google لبريد `you+googletest@example.com` ثم جرّب «إنشاء حساب» بالبريد نفسه مع كلمة مرور؛ يجب ظهور مسار ربط واضح ثم حساب Firebase موحّد.
- `VITE_AUTH_PASSWORD_RESET_REVEAL_NOT_FOUND`:
  - اتركه فارغًا في الإنتاج لسلوك مضاد للتعداد (نجاح ظاهري حتى لو لا يوجد حساب).
  - ضع `1` أثناء التصحيح لرؤية `auth/user-not-found` في الواجهة.

### 1.1) قالب بريد إعادة تعيين كلمة المرور (عربي وتسليم أفضل)

محتوى الرسالة الافتراضية يأتي من **Firebase Console** وليس من كود الواجهة. لتحسين اللغة والمظهر وتقليل تصنيف الرسالة كغير مرغوب:

- من **Authentication** → **Templates** → **Password reset**:
  - غيّر **Subject** إلى صياغة عربية واضحة ومختصرة (مثال: «إعادة تعيين كلمة مرور فاهم»).
  - عدّل **Body** إلى ترحيب عربي مختصر، مع ذكر اسم التطبيق والغرض (رابط لمرة استخدام).
  - احتفظ بالمتغير الرسمي الذي يدرج رابط إعادة التعيين (يظهر في محرر القالب في Console) حتى يعمل `oobCode` و`handleCodeInApp`.
- **Authorized domains**: تأكد أن نطاق الإنتاج والاستضافة مضاف، وأن `VITE_FIREBASE_EMAIL_RESET_CONTINUE_URL` يشير إلى عنوان **HTTPS** على نفس النطاق المعتمد.
- **سمعة الإرسال (Deliverability)** على المدى الطويل:
  - رسائل Firebase الافتراضية تُرسل من بنية Google؛ تحسين السمعة يكون غالباً عبر استخدام **نطاق مخصّص**، وإعداد **SPF** و**DKIM** عند مزوّد النطاق إذا انتقلتم لاحقاً إلى مرسل بريد مخصص أو خدمة طرف ثالث.
  - تجنّب عناوين «بيع» أو علامات كثيرة في الموضوع؛ رابط واحد واضح يقلل الشك لدى عوامل التصفية.
- للتحقق: أرسل إعادة تعيين من الواجهة بعد التخصيص وتأكد أن النص العربي يظهر في صندوق الوارد (وجرب مجلد الرسائل غير المرغوبة مرة واحدة بعد التغيير).

### 1.2) أداء تسجيل الدخول بـ Google (الواجهة)

- **عدم `prompt=select_account` في الكود:** لتحسين السرعة لمن لديه حساب Google واحد، لا يُمرَّر مؤشر اختيار الحساب في كل مرة؛ المتصفح يعتمد جلسة Google الحالية. إذا احتجتم فرض اختيار حساب آخر، يمكن للمستخدم تسجيل الخروج من Google في المتصفح أو استخدام نافذة خاصة للاختبار.
- **تهيئة مسبقة:** يتم استدعاء تهيئة Firebase Auth عند تحميل الصفحة لتقليل التأخير على أول نقرة «تسجيل الدخول».
- **قياس زمني:** في أدوات المطور → تبويب **Performance** يمكن رصد مقاييس مثل `fahem-auth:google-popup-ui` (نافذة Google) و`fahem-auth:firebase-sync-total` (من الرمز حتى جلسة التطبيق بعد التبادل).

## 2) إعداد البيئة

- عميل الويب (`VITE_FIREBASE_*`) في `.env`.
- الباك-إند:
  - `FIREBASE_PROJECT_ID`
  - `FIREBASE_CLIENT_EMAIL`
  - `FIREBASE_PRIVATE_KEY`
  - `AUTH_JWT_SECRET`
  - ملاحظة: `FIREBASE_SERVICE_ACCOUNT_PATH` fallback محلي للتطوير فقط.

## 2.1) إعداد Render (Cloud-native)

- أضف هذه المتغيرات في Render:
  - `FIREBASE_PROJECT_ID`
  - `FIREBASE_CLIENT_EMAIL`
  - `FIREBASE_PRIVATE_KEY`
- استخراج القيم من Firebase Admin JSON:
  - `FIREBASE_PROJECT_ID`  <= `project_id`
  - `FIREBASE_CLIENT_EMAIL` <= `client_email`
  - `FIREBASE_PRIVATE_KEY` <= `private_key`
- private key multiline:
  - الأفضل لصقه كما هو بأسطر حقيقية.
  - إذا واجهة الإدخال لا تدعم multiline، استخدم `\\n`، والكود يحوّله إلى newline تلقائيًا.

## 3) تسلسل التشغيل المتوقع

1. المستخدم يسجل عبر Firebase (Google / email-password).
2. الواجهة ترسل Firebase ID token إلى `/api/auth/exchange`.
3. الباك-إند يثبت الهوية، يربط/ينشئ internal user، ثم يصدر session داخل PostgreSQL، ويعيد في الجسم `user` مع `id` و`roles` و`email` و`displayName` من جدول `users`.
4. في مسار التبادل الناجح، الواجهة تستخدم هذا السياق دون طلب `GET /api/auth/me` إضافياً؛ لا يزال المسار `/api/auth/me` متاحاً عند الحاجة لتحديث البيانات لاحقاً.

## 4) Smoke Checklist

- `npm run build:server`
- `npm run build:client`
- `npm run auth:check-conventions`
- `npm run auth:check-client-boundaries`
- `npm run db:check-schema`
- `npm run auth:lifecycle-smoke` (web/mobile session lifecycle + optional exchange)
- تدفق يدوي: Google + Email/Password + Forgot/Reset + Logout + Session restore.

## 5) Troubleshooting سريع

- خطأ `csrf_mismatch`: تأكد من وجود `fahem_csrf_token` وإرسال `X-CSRF-Token`.
- فشل Password Reset بعد فتح الرسالة:
  - تأكد أن الرابط يحتوي `mode=resetPassword` و`oobCode`.
  - راقب وحدة تحكم المتصفح لأحداث `[auth-trace]` من `password_reset_send_*` و`password_reset_confirm_*`.
  - راجع `Authorized domains` وقيمة `VITE_FIREBASE_EMAIL_RESET_CONTINUE_URL`.
- حساب موجود بمزود آخر: تستخدم الواجهة خطوط ربط مع `auth/email-already-in-use` و`auth/account-exists-with-different-credential`؛ راقب `[auth-trace]` لوجود `provider_conflict_detected` و`credential_pending_link_*`؛ إن بقي للمستخدم أكثر من مزود لنفس البريد تأكّد بعد النجاح عبر وحدة Firebase أن `fetchSignInMethodsForEmail` يعكس ذلك.
- خطأ `auth_exchange_failed` بعد نجاح Firebase في الواجهة:
  - تأكد أن `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` مضبوطة في Render.
  - راجع logs للتأكد من عدم وجود أخطاء `default credentials` أو `private key parse`.
- إذا ظهر `auth/popup-closed-by-user` رغم اختيار الحساب بنجاح:
  - تحقق من header `Cross-Origin-Opener-Policy` في استجابة الصفحة الرئيسية.
  - يجب أن تكون القيمة `same-origin-allow-popups` (وليست `same-origin`) لتدفق Google popup.

## 6) Incident Response (Auth)

- `auth.refresh.reuse_detected`: اعتبرها إشارة تسريب refresh token. نفّذ revoke للجلسة المتأثرة واطلب إعادة تسجيل دخول.
- تكرار `auth.refresh.rotation_conflict`: راجع وجود race أو إعادة استخدام token من أكثر من جهاز.
- ارتفاع `auth.refresh.csrf_mismatch` أو `auth.logout.csrf_mismatch`: راجع إعدادات الكوكيز، البروكسي، والدومين.
- محاولات وصول `401/403` متكررة على `/admin` و`/api/admin/*`: راجع إعداد RBAC والأدوار.

## 7) Retention + Alerts + Dashboards

- **Retention baseline:** جدول `public.auth_observability_settings` يحدد `events_retention_days` (افتراضي 90 يوم).
- **Daily dashboard source:** العرض `public.auth_event_daily_metrics` لتجميع الأحداث اليومية حسب `event_type`.
- **Alerts المقترحة:**
  - `auth.refresh.reuse_detected` > 0 خلال 10 دقائق.
  - `auth.refresh.rotation_conflict` spike (انحراف > 3x baseline).
  - ارتفاع `auth.access.forbidden` أو `auth.access.unauthorized` غير معتاد.
  - `socket_auth_failures` (عند إضافته) أعلى من العتبة المتوقعة.
- **Retention job (تشغيلي):** نفّذ مهمة دورية يومية لحذف `auth_events` الأقدم من `events_retention_days`.
