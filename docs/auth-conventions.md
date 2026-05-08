# Auth Conventions

## 1) Identity Rules

- ممنوع استخدام Firebase UID كمعرّف داخلي للدومين.
- الهوية الداخلية المسموح بها في الكود هي `userId` من `public.users.id`.
- أي جدول دوميني جديد يربط بالمستخدم يجب أن يشير إلى UUID داخلي.

## 2) Provider Rules

- أي provider جديد يجب أن يطبّق `AuthProvider` فقط.
- ممنوع استدعاء Firebase Admin SDK مباشرة من routes/services الدومينية.
- الاستدعاء الخارجي للـ provider يجب أن يكون داخل طبقة `server/auth`.

## 3) Session & Token Rules

- access token قصير العمر.
- refresh token مخزّن بشكل hash داخل `public.user_sessions`.
- revoke/logout يجب أن يحدّث session state في PostgreSQL.

## 4) Authorization Rules

- `requireAuth` لأي endpoint يحتاج user context.
- `requireRole("admin")` لأي endpoint إداري.
- ممنوع أي guard يعتمد shared secret header.

## 5) Socket Rules

- Socket handshake يجب أن يحمل access token صحيح.
- هوية اللاعب في المسارات الحساسة تعتمد user identity الموثقة.
- `playerSessionId` من العميل لا يُعتبر مرجع أمني مستقل.

## 6) SQL Rules

- Auth SQL يجب أن يكون deterministic (`public.<table>`).
- أي migration auth جديدة يجب أن تكون idempotent قدر الإمكان.

## 7) Quality Gates

- `npm run auth:check-conventions` يجب أن يمر قبل الدمج.
- `npm run db:check-schema` يجب أن يمر قبل الدمج.
- `npm run auth:check-client-boundaries` يجب أن يمر قبل الدمج (لمنع Firebase leakage خارج `client/src/auth/*`).

## 8) Frontend Auth Rules

- ممنوع استيراد `firebase/*` خارج `client/src/auth/*`.
- أي شاشة UI تتعامل مع المصادقة تستخدم `authFlows` و`authStore` فقط.
- Passwordless Email Link يستخدم `linkDomain` الحديث مع `handleCodeInApp=true`.

## 9) CSRF / Cookies

- عمليات `refresh` و`logout` تتطلب `X-CSRF-Token` مطابقًا للكوكي `fahem_csrf_token`.
- كوكي الجلسة تبقى HttpOnly (`fahem_access_token` / `fahem_refresh_token`)، وكوكي CSRF فقط non-HttpOnly.
