# عقد idempotency لإعادة الربط (Phase E)

**لا يغيّر هذا المستند بروتوكول السلك** — يوثّق السلوك الحالي في [`server/game/coordinators/ReconnectCoordinator.ts`](../server/game/coordinators/ReconnectCoordinator.ts) والخرائط في [`server/game/GameManager.ts`](../server/game/GameManager.ts) لمساعدة المراجعين وللفرق الصغيرة.

مرتبط: [IDENTITY_AND_RECONNECT.md](IDENTITY_AND_RECONNECT.md) (الأقسام 4–6).

---

## 1) `resume_match` — نفس المقبس، نفس الحمولة الصالحة مرتين

**السلوك المقصود (عقدة واحدة)**:

1. أول نجاح: يُحدَّث `currentSocketId` في `Match`، تُعاد خرائط `socketToParticipantId` / `participantIdToSocket`، يُفصل أي مقبس سابق لنفس `participantId` في **نفس** المباراة، يُدار الرمز (`rotateResumeSecret`)، يُعاد `match_resume_token` عند الاقتضاء.
2. ثانٍ نجاح بنفس المقبس بعد الدوران: يجب أن يظل الاستدعاء **آمناً** — العميل يستخدم الرمز الأحدث من آخر `match_resume_token`؛ الرمز القديم يرفض بـ `bad_token` بعد الدوران (سلوك مقصود لتضييق النافذة).

**Idempotency تشغيلية**: إعادة ربط المقبس الحالي بنجاح ثانٍ مع رمز صالح حالي ليست خطأ — تُعاد المزامنة (join، لقطة، إلخ) كما في المسار الأول.

---

## 2) `resume_match` أثناء `draining`

- يردّ بـ **`server_draining`** (انظر `ReconnectCoordinator` + `Ack.server_draining`).
- **عقد**: لا استئناف مباراة جديد بعد بدء التصريف — يجب أن يفهم العميل أن النشر/الإيقاف قيد التنفيذ.

---

## 3) حد المعدّل (`rate_limited`)

- عدّاد لكل **`socket.id`** في نافذة زمنية (ثوابت في `GameManager`).
- **ليس** idempotency عامة — يحمي الخادم من حلقات عميل خاطئة أو إعادة إرسال مفرطة.

---

## 4) `continue_as_spectator`

- يعتمد على وجود مباراة حية وربط `fahemMatchId` عند الحاجة — انظر [IDENTITY_AND_RECONNECT.md](IDENTITY_AND_RECONNECT.md).
- يجب أن يبقى التحقق عبر `continueSpectatorSchema` كما هو؛ لا تغيير بروتوكول في Phase E.

---

## 5) أحداث مكررة من العميل

- Socket.IO قد يسبب إعادة إرسال؛ المسارات تستخدم **`safeParse`** ورفض `invalid_body`.
- **مخاطر حالية منخفضة** إذا بقي العميل على عقد «رمز واحد صالح في كل مرة».

---

## 6) اختبارات

- مخطط الحمولة: [`server/game/socketSchemas.test.ts`](../server/game/socketSchemas.test.ts) — يتضمن تحققاً أن نفس حمولة `resume_match` الصالحة تُقبل عند التحليل المتكرر (طبقة التحقق فقط، لا محاكاة خرائط GM).

---

## 7) إشارات مراقبة

- تكرار `resume_match_result` مع `error: rate_limited` أو `server_draining` أثناء النشر.
- ارتفاع مفاجئ في `bad_token` بعد نشر عميل جديد (غالباً عدم تطابق الرمز/النسخة).

---

## 8) التراجع

وثائق + اختبارات مخطط فقط — لا تأثير على سلوك وقت التشغيل من هذه الوثيقة.
