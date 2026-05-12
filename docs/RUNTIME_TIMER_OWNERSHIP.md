# ملكية المؤقتات والإلغاء عند التصريف (Phase E)

الهدف: جعل سؤال **«من يملك هذا المؤقت ومن يلغيه؟»** قابلاً للإجابة من الوثائق دون قراءة كامل الملفات في كل مرة.

مرتبط: [دورة حياة الإيقاف](RUNTIME_LIFECYCLE_SHUTDOWN.md)، [عقد أحادية العقدة](RUNTIME_SINGLE_NODE_CONTRACT.md).

---

## 1) `GameManager` — مؤقتات وأدوات زمنية

| المالك | الحقل / المسار | الغرض | يُلغى عند |
|--------|----------------|--------|-----------|
| GM | `matchStartTimers[mode]` | عدّ تنازلي لبدء مباراة من اللوبي العام | `abortAllMatchesForShutdown`، ومسارات إلغاء العد في المعالجات (مثل إلغاء الجاهزية) |
| GM | `pendingReconnectByParticipantId` | نافذة سماح بعد `disconnect` قبل إقصاء المقعد | نجاح `resume_match`، انتهاء المهلة، `unregisterMatchRoutingForMatch`، **`abortAllMatchesForShutdown`** |
| GM | `privateRoomGcInterval` | جمع غرف خاصة فارغة (دوري) | `stopPeriodicTasks` (مرحلة إيقاف) |
| غرفة خاصة | `PrivateRoomState.matchStartTimer` | عدّ تنازلي بدء من غرفة خاصة | مسارات الإلغاء/البدء في المعالجات؛ **`abortAllMatchesForShutdown`** يمرّ على `privateRooms` لإلغاء المؤقت وتصفير `countdownEndsAt` و`lockedParticipantIds` وتحديث `emitPrivateLobbyState` عند الحاجة |

**ملاحظة**: `resumeMatchRateBySocketId` ليس مؤقتاً بل عدّاد نافذة زمنية في الذاكرة؛ يُفقد عند إنهاء العملية.

---

## 2) `Match` — مؤقتات الجولة

| المالك | الحقل | الغرض | يُلغى عند |
|--------|------|--------|-----------|
| Match | `questionTimer` | مهلة السؤال | `clearQuestionTimers`، مسارات إنهاء الجولة |
| Match | `abilityGraceTimer` | نافذة سماح بعد الجولة للقدرات | `clearQuestionTimers` |
| Match | `studyWaitTimer` | انتظار/انتقال المذاكرة | `clearStudyWait`، مسارات الجولة |
| Match | `roundReadyTimer` | نافذة جاهزية الجولة | مسارات الجولة، `clearStudyWait` / تنظيف الجولة |

عند **`abortDueToServerShutdown`**: يستدعي `emitAbortGameOver` الذي يستدعي **`releasePendingRoundWait`**, **`clearStudyWait`**, **`clearQuestionTimers`** ثم يعلّم `finished` — أي لا تبقى مؤقتات مفعّلة لهذا المباراة بعد الإنهاء.

---

## 3) ترتيب الإلغاء عند `abortAllMatchesForShutdown`

1. لكل مباراة: `abortDueToServerShutdown()` (يُفرّغ مؤقتات `Match` الداخلية ويُنهي المباراة).
2. `unregisterMatchRoutingForMatch` (تنظيف خرائط GM و`pendingReconnect` للمقاعد).
3. `runningMatches.clear()`.
4. مسح جميع `pendingReconnectByParticipantId`.
5. إلغاء `matchStartTimers` لكل أوضاع اللوبي وإعادة تعيين الحقول المرتبطة بالعد.
6. لكل غرفة خاصة: إلغاء `matchStartTimer` إن وُجد، وتصفير `countdownEndsAt` و`lockedParticipantIds` عند الحاجة، وزيادة `roomVersion` و`emitPrivateLobbyState` للغرف المتأثرة.

---

## 4) idempotency لإلغاء المؤقت

- استدعاء `clearTimeout(null)` أو إلغاء مؤقت سبق إلغاؤه يجب أن يبقى آمناً — الكود يستخدم فحوصات `!= null` حيث يلزم.

---

## 5) التحقق

- اختبارات وحدة: [`server/shutdownUtils.test.ts`](../server/shutdownUtils.test.ts) لمهلات الإيقاف.
- يدوي: staging + SIGTERM مع مباراة نشطة ولوبي في عدّ تنازلي — التحقق من عدم تسرب مؤقتات (عبر السجلات و`/health/realtime` إن أمكن قبل الخروج).
