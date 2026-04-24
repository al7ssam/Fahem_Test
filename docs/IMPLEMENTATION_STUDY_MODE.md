# نمط «بطاقات ثم أسئلة» — حالة التنفيذ

تم تنفيذ المسار الكامل في المشروع: الترحيل، `Match` مع `GameMode`، `GameManager` بغرف لوبي منفصلة لكل نمط، وواجهة العميل (`join_lobby` مع `mode`، مرحلة `studying`، أحداث `study_phase` / `study_phase_end`).

الأقسام أدناه تبقّى كمرجع تقني لشكل الدوال والإعدادات (قد لا تطابق السطر حرفياً مع الملف الحالي).

## 1) [`server/db/questions.ts`](../server/db/questions.ts)

أضف في نهاية الملف (بعد الدالة `getRandomQuestion`):

```ts
export async function getRandomQuestionBlock(
  pool: import("pg").Pool,
  excludeIds: number[],
  count: number,
): Promise<QuestionRow[]> {
  const out: QuestionRow[] = [];
  const exclude = [...excludeIds];
  for (let i = 0; i < count; i++) {
    const q = await getRandomQuestion(pool, exclude);
    if (!q) break;
    exclude.push(q.id);
    out.push(q);
  }
  return out;
}
```

## 2) [`server/config.ts`](../server/config.ts)

بعد `adminSecret` أضف:

```ts
const studyPhaseMs = Number(process.env.STUDY_PHASE_MS) || 60_000;
const studyQuizBlockSize = Number(process.env.STUDY_QUIZ_BLOCK_SIZE) || 8;
const maxStudyCardsDisplay = Number(process.env.MAX_STUDY_CARDS_DISPLAY) || 8;
```

وفي كائن `config` أضف المفاتيح: `studyPhaseMs`, `studyQuizBlockSize`, `maxStudyCardsDisplay`.

## 3) [`server/scripts/migrate.ts`](../server/scripts/migrate.ts)

استبدل قراءة ملف واحد بحلقة على كل `*.sql` مرتبة بالاسم في `db/migrations` (كما في الخطة).

## 4) [`server/game/Match.ts`](../server/game/Match.ts)

استبدل الملف بالكامل بالمحتوى الموجود في مستودع Git بعد التنفيذ — المطلوب:

- تصدير `GameMode = "direct" | "study_then_quiz"`.
- `constructor(..., gameMode: GameMode)`.
- `game_started` يتضمن `gameMode`.
- `direct`: حلقة `getRandomQuestion` كاليوم حتى فائز أو `MAX_ROUNDS`.
- `study_then_quiz`: حلقة ماكرو — `getRandomQuestionBlock` بحجم `config.studyQuizBlockSize`، ثم `getStudyCardsForQuestions` مع `config.maxStudyCardsDisplay`، ثم `study_phase` / انتظار `STUDY_PHASE_MS` / `study_phase_end`، ثم لعب كل سؤال في الكتلة بـ `playOneQuestion` (نفس منطق القلوب والمؤقت). تكرار حتى فائز واحد أو نفاد أسئلة.
- `handleDisconnect` يلغي مؤقت مرحلة القراءة إن وُجد (`clearStudyWait`).

## 5) [`server/game/GameManager.ts`](../server/game/GameManager.ts)

- `joinLobbySchema`: إضافة `mode: z.enum(["direct", "study_then_quiz"]).default("direct")`.
- غرف Socket.io: `lobby:direct` و `lobby:study_then_quiz` بدل `lobby` الواحدة.
- `LobbyEntry` يتضمن `mode`.
- خريطتان `Map` للاعبين (أو سجل `{ direct, study_then_quiz }`) + مؤقتان منفصلان لـ `scheduleMatchStart`.
- `broadcastLobby(mode)` و`startMatchFromLobby(mode)` يمرّران `mode` إلى `new Match(..., mode)`.
- عند `disconnect`/`removeFromLobby`: إزالة اللاعب من الخريطة الصحيحة حسب `entry.mode`.

## 6) [`client/src/main.ts`](../client/src/main.ts)

- متغير `selectedGameMode` + واجهة اختيار نمط في شاشة الاسم.
- `join_lobby` يرسل `{ name, mode: selectedGameMode }`.
- `lobby_state` يعرض تسمية النمط إن أُرسلت من الخادم (`mode` في كل لاعب أو في الجذر).
- مرحلة جديدة `study`: عند `study_phase` عرض بطاقات قابلة للتمرير + مؤقت `endsAt`؛ القلوب من آخر `game_started` أو `question_result`.
- `game_started`: إن `gameMode === "study_then_quiz"` لا تنتقل مباشرة لواجهة السؤال؛ انتظر `study_phase` أو اعرض شاشة انتظار خفيفة.
- `study_phase_end`: لا تغيّر الشاشة إن كان السؤال التالي سيصل فوراً.

## 7) [`.env.example`](../.env.example) و [`DEPLOY.md`](../DEPLOY.md)

أضف:

- `STUDY_PHASE_MS=60000`
- `STUDY_QUIZ_BLOCK_SIZE=8`
- `MAX_STUDY_CARDS_DISPLAY=8`

## 8) التحقق

```bash
npm run build
```

---

بعد لصق الكود: ادفع إلى GitHub وعلى Render يُنفَّذ الترحيل `002` تلقائياً مع `npm start` الحالي.
