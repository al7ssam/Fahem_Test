# Auth Runbook (Firebase + Internal Sessions)

## 1) إعداد Firebase Console

- فعّل Providers: `Google`, `Email/Password`, `Email Link`.
- أضف جميع `Authorized Domains` اللازمة (local + production).
- Email Link:
  - فعّل Firebase Hosting link domain.
  - استخدم نفس domain داخل `VITE_FIREBASE_LINK_DOMAIN`.

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

1. المستخدم يسجل عبر Firebase (Google / email-password / email-link).
2. الواجهة ترسل Firebase ID token إلى `/api/auth/exchange`.
3. الباك-إند يثبت الهوية، يربط/ينشئ internal user، ثم يصدر session داخل PostgreSQL.
4. الواجهة تستدعي `/api/auth/me` لاسترجاع user context النهائي.

## 4) Smoke Checklist

- `npm run build:server`
- `npm run build:client`
- `npm run auth:check-conventions`
- `npm run auth:check-client-boundaries`
- `npm run db:check-schema`
- `npm run auth:lifecycle-smoke` (web/mobile session lifecycle + optional exchange)
- تدفق يدوي: Google + Email/Password + Email Link + Logout + Session restore.

## 5) Troubleshooting سريع

- خطأ `csrf_mismatch`: تأكد من وجود `fahem_csrf_token` وإرسال `X-CSRF-Token`.
- فشل Email Link completion: تأكد من domain الصحيح في `Authorized Domains` و`VITE_FIREBASE_LINK_DOMAIN`.
- حساب موجود بمزود آخر: استخدم مسار تسجيل الدخول بالمزود الصحيح ثم linking.
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
