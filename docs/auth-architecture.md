# Auth Architecture (Provider-Agnostic)

## مبادئ أساسية

- PostgreSQL هو مصدر الحقيقة الوحيد لهوية المستخدم الداخلية.
- Firebase Authentication مزود هوية خارجي فقط (Provider).
- الهوية الداخلية هي `public.users.id` (UUID) ولا تعتمد على `provider uid`.
- أي authorization في الباك-إند يعتمد على roles/permissions داخل PostgreSQL.

## طبقات النظام

1. `server/auth/AuthProvider.ts`
   - عقد موحد لأي مزود مصادقة خارجي.
2. `server/auth/FirebaseAuthProvider.ts`
   - تنفيذ مزود Firebase فقط.
3. `server/auth/AuthService.ts`
   - orchestration: verify external token -> link/resolve internal user -> issue sessions/tokens.
4. `server/auth/repository.ts`
   - data access deterministic لـ users/identities/roles/sessions.
5. `server/auth/middleware.ts`
   - `requireAuth`, `optionalAuth`, `requireRole`.
6. `server/auth/socketAuth.ts`
   - Socket.IO auth verification بنفس access token policy.

## Session Model (Hybrid)

- Web:
  - HttpOnly cookies (`fahem_access_token`, `fahem_refresh_token`).
- Mobile/Flutter:
  - Bearer access token + refresh token.
- كلتا القناتين تعتمدان نفس `AuthService` ونفس `public.user_sessions`.

## Account Linking Policy

- الربط بالبريد يتم فقط عند `email_verified = true` من المزود.
- unique constraint على `(provider, provider_user_id)` يمنع تضارب provider identities.
- unique جزئي على `public.user_emails.email_canonical` للحسابات الموثقة يمنع تعدد الحسابات لنفس البريد الموثق.

## Admin Authorization

- تم استبدال الاعتماد الأمني على `x-admin-secret`.
- الوصول إلى `/api/admin/*` يعتمد role `admin` من `public.user_roles`.
- منح `admin` يتم عبر `AUTH_ADMIN_EMAILS` بشكل صريح ومتحكم به.

## Migration Readiness

- استبدال Firebase لاحقاً يتم عبر إضافة Provider جديد يطبّق `AuthProvider` بدون تغيير domain schema.
- لا يوجد coupling في الدومين على Firebase UID.

## Frontend Integration (Web)

- جميع استدعاءات Firebase Web SDK محصورة داخل `client/src/auth/*`.
- `client/src/auth/authStore.ts` هو مصدر الحالة الموحد (loading/authenticated/unauthenticated/error).
- `client/src/auth/authFlows.ts` يدير Google + Email/Password + Passwordless Email Link ويجري تبادل التوكن مع `/api/auth/exchange`.
- `client/src/auth/sessionSync.ts` ينفذ session restore deterministic عند bootstrap.
- `client/src/auth/socketSync.ts` يمنع socket sessions قديمة بعد logout/expiration.

## Passwordless Policy (Modern)

- تفعيل Email Link يعتمد `ActionCodeSettings.linkDomain` (Hosting link domain).
- لا نعتمد `dynamicLinkDomain` (deprecated).
- إكمال رابط الدخول يتم عبر `signInWithEmailLink` ثم exchange مع الباك-إند لإصدار جلسة داخلية.
