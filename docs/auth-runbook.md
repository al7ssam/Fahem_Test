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
  - `FIREBASE_SERVICE_ACCOUNT_PATH`
  - `AUTH_JWT_SECRET`

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
- تدفق يدوي: Google + Email/Password + Email Link + Logout + Session restore.

## 5) Troubleshooting سريع

- خطأ `csrf_mismatch`: تأكد من وجود `fahem_csrf_token` وإرسال `X-CSRF-Token`.
- فشل Email Link completion: تأكد من domain الصحيح في `Authorized Domains` و`VITE_FIREBASE_LINK_DOMAIN`.
- حساب موجود بمزود آخر: استخدم مسار تسجيل الدخول بالمزود الصحيح ثم linking.

## 6) Incident Response (Auth)

- `auth.refresh.reuse_detected`: اعتبرها إشارة تسريب refresh token. نفّذ revoke للجلسة المتأثرة واطلب إعادة تسجيل دخول.
- تكرار `auth.refresh.rotation_conflict`: راجع وجود race أو إعادة استخدام token من أكثر من جهاز.
- ارتفاع `auth.refresh.csrf_mismatch` أو `auth.logout.csrf_mismatch`: راجع إعدادات الكوكيز، البروكسي، والدومين.
- محاولات وصول `401/403` متكررة على `/admin` و`/api/admin/*`: راجع إعداد RBAC والأدوار.
