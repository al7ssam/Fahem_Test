# Google Auth Root-Cause Report

## Executive Summary

- السبب الجذري الأساسي كان في **Frontend orchestration** قبل `/api/auth/exchange`.
- منطق fallback من popup إلى redirect كان يعتمد على `error.message` بدل `FirebaseError.code`.
- أخطاء redirect bootstrap كانت تُبتلع (`catch(() => false)`) في `main.ts`، فكان الفشل صامتًا ويظهر للمستخدم كسلوك “اختيار حساب مرتين” بدون login.

## Root Cause (Primary)

1. **Message-based branching fragility**
   - في `client/src/auth/authFlows.ts` كان القرار:
     - إذا `message` يحتوي `popup` أو `cancelled` -> `signInWithRedirect`.
   - هذا يسبب fallback غير صحيح في حالات لا تتطلب redirect.
2. **Silent redirect bootstrap failure**
   - في `client/src/main.ts` كان `completeGoogleRedirectLogin().catch(() => false)`.
   - هذا أخفى سبب الفشل الحقيقي ومنع تشخيصه.

## Contributing Factors

- عدم وجود instrumentation متسلسلة تربط:
  - click -> popup -> redirect -> idToken -> exchange.
- غياب lock يمنع محاولات Google متزامنة.
- رسائل UI عامة لا تُظهر أين توقف المسار.

## Why `/api/auth/exchange` did not appear

- لأن التدفق كان يتعثر قبل الوصول إلى `syncBackendFromFirebaseCredential` في بعض المسارات:
  - إما redirect fallback خاطئ.
  - أو redirect bootstrap failure صامت.
- بالتالي لم يصل الكود إلى نقطة `exchangeFirebaseToken()`.

## Fixes Implemented

1. **Structured instrumentation**
   - إضافة `traceId` و`[auth-trace]` logs في مراحل Google popup/redirect/exchange.
   - تخزين trace ring-buffer في `window.__fahemAuthTrace`.
2. **Strict Google orchestration**
   - اعتماد `FirebaseError.code` بدل message contains.
   - fallback إلى redirect فقط لكودات محددة (`auth/popup-blocked`, `auth/operation-not-supported-in-this-environment`).
   - التعامل مع `popup-closed-by-user` و`cancelled-popup-request` كمسارات غير خطأ قاتل.
3. **Race/loop protection**
   - lock عبر `googleFlowInFlight`.
   - redirect bootstrap idempotent (`redirectBootstrapHandled`).
4. **Pre-exchange hard checks**
   - التحقق من وجود user.
   - تتبع `getIdToken(true)` نجاح/فشل مع قياس.
5. **Visibility improvement**
   - عدم ابتلاع أخطاء redirect bootstrap في `main.ts`، وتسجيل السبب.

## Architectural vs Implementation Assessment

- **المشكلة Bug تنفيذي** في branching/error handling.
- **لكن** يوجد كذلك **fragility معمارية** في orchestration لأن fallback logic كان heuristic مبني على message.

## Trace Workflow (for validation)

1. افتح DevTools Console.
2. نفذ Google login.
3. راقب `[auth-trace]` events بالترتيب:
   - `google_login_click`
   - `google_popup_start`
   - `google_popup_success` أو `google_popup_failed`
   - `firebase_get_id_token_start/success`
   - `exchange_request_start`
   - `exchange_fetch_dispatch/success`
4. في حال فشل، راجع:
   - `google_popup_failed.code`
   - `redirect_result_failed.code`
   - `exchange_fetch_failed.status/reason`

## Residual Risk

- ما زال نجاح Google يعتمد على إعدادات Firebase Console وAuthorized Domains.
- `ERR_BLOCKED_BY_CLIENT` من play.google telemetry يبقى noise متوقعًا ولا يُعتبر root cause.

## Acceptance Criteria

- Google popup success ينتهي بحالة authenticated.
- redirect fallback يعمل فقط عند الأكواد الصحيحة.
- `/api/auth/exchange` يظهر في Network لجميع المسارات الناجحة.
- لا توجد loops أو silent failures.
