/**
 * مولّد نص برومبت إنشاء درس (نسخة العميل).
 * عند تعديل القواعد حدّث أيضاً buildAiLessonPrompt في server/templates/admin-lessons.html.
 */
export type LessonAiPromptParams = {
  nSec: number;
  qSame: number;
  ansSec: number;
  studySec: number;
  /** موضوع الدرس / المنهاج */
  topic: string;
  /** مستوى الجمهور (نص اختياري) */
  audience: string;
  minSentences: number;
  maxSentences: number;
};

function clampLessonPromptParams(p: LessonAiPromptParams): LessonAiPromptParams {
  let minS = Math.min(20, Math.max(1, Math.trunc(p.minSentences) || 1));
  let maxS = Math.min(20, Math.max(1, Math.trunc(p.maxSentences) || 3));
  if (maxS < minS) [minS, maxS] = [maxS, minS];
  return {
    nSec: Math.min(20, Math.max(1, Math.trunc(p.nSec) || 3)),
    qSame: Math.min(50, Math.max(1, Math.trunc(p.qSame) || 3)),
    ansSec: Math.min(120, Math.max(3, Number.isFinite(p.ansSec) ? p.ansSec : 15)),
    studySec: Math.min(300, Math.max(2, Number.isFinite(p.studySec) ? p.studySec : 60)),
    topic: String(p.topic ?? "").trim(),
    audience: String(p.audience ?? "").trim(),
    minSentences: minS,
    maxSentences: maxS,
  };
}

export function buildLessonAiPromptText(raw: LessonAiPromptParams): string {
  const p = clampLessonPromptParams(raw);
  const defaultAnswerMs = Math.round(p.ansSec * 1000);
  const studyPhaseMsUnified = Math.round(p.studySec * 1000);
  const sectionBlock =
    `جميع الأقسام الـ ${p.nSec}: لكل قسم items بعدد موحّد ${p.qSame} سؤالاً، وstudyPhaseMs = ${studyPhaseMsUnified} (مللي ثانية) لكل قسم.`;

  let topicBlock = "";
  if (p.topic || p.audience) {
    topicBlock = "\nسياق الموضوع والجمهور:\n";
    if (p.topic) topicBlock += `${p.topic}\n`;
    if (p.audience) topicBlock += `مستوى الجمهور المستهدف: ${p.audience}\n`;
  }

  const lengthStudyBodyLine = `— الطول: استخدم من ${p.minSentences} إلى ${p.maxSentences} جملة كحد أقصى، مركزة وغنية.\n`;
  const strictJsonRules =
    "قواعد JSON القياسية (RFC 8259) — إلزامي:\n" +
    "— المخرجات = كائن جذر واحد فقط يحتوي المفتاحين lesson و sections بالضبط؛ لا مفاتيح إضافية في الجذر.\n" +
    "— جميع مفاتيح الكائنات والسلاسل النصية بين علامتي تنصيص مزدوجة ASCII (\")؛ يُمنع استخدام علامات التنصيص المفردة (') كحدود لسلسلة JSON.\n" +
    "— الأرقام (defaultAnswerMs، studyPhaseMs، correctIndex، sortOrder) يجب أن تكون أرقاماً JSON خامة بلا علامات اقتباس.\n" +
    "— correctIndex: إن كان options بطول 2 فالمسموح 0 أو 1 فقط؛ إن كان بطول 4 فالمسموح 0 أو 1 أو 2 أو 3 فقط.\n" +
    "— difficulty نص JSON فقط واحد من الثلاثة: \"easy\" أو \"medium\" أو \"hard\" (أحرف إنجليزية صغيرة).\n" +
    "— لا تلف المخرجات داخل سياج Markdown ولا تسبقها أو تلحقها بأي نص؛ لا تعليقات // ولا /* */ داخل JSON.\n" +
    "— لا فاصلة ختامية بعد آخر عنصر في {} أو []. لا تستخدم undefined أو NaN أو Infinity.\n" +
    "— slug وdescription يمكن أن تكون null أو نصاً؛ sortOrder عدد صحيح (استخدم 0 إن لم يكن لديك تفضيل).\n\n";
  const jsonShapeExample = JSON.stringify(
    {
      lesson: {
        title: "عنوان الدرس",
        slug: null,
        description: null,
        defaultAnswerMs,
        sortOrder: 0,
      },
      sections: [
        {
          titleAr: "عنوان القسم",
          studyPhaseMs: studyPhaseMsUnified,
          items: [
            {
              prompt: "نص السؤال؟",
              options: ["خيار أ", "خيار ب", "خيار ج", "خيار د"],
              correctIndex: 0,
              difficulty: "medium",
              studyBody: "نص بطاقة المذاكرة.",
            },
          ],
        },
      ],
    },
    null,
    2,
  );
  const qualityBlock =
    "\nجودة المحتوى (إلزامي اتباع الروح):\n" +
    "— المشتتات: اجعل الخيارات الخاطئة من نفس المجال وتبدو معقولة لمن لم يقرأ بطاقة المذاكرة جيداً؛ تجنّب الخيارات السخيفة أو البديهية جداً.\n" +
    "— تطابق المذاكرة والاختبار: يجب أن يوفّر studyBody المفهوم أو المهارة التي تمكّن الطالب من الإجابة الصحيحة، دون تلقين الحل المباشر ودون إعادة نفس أرقام السؤال أو معادلاته أو أمثلته؛ قدّم المعلومة اللازمة كشرح مفهومي أو قاعدة عامة يستنتج منها الطالب الحل. لا تطلب معلومة خارج ما علّمته البطاقة.\n" +
    "— بناء المعرفة ومنع تسريب الحل (قاعدة صارمة): الهدف من البطاقة هو إكساب الطالب المهارة وليس حل المسألة له. يُحظر تماماً (Strictly Forbidden) استخدام نفس الأرقام، المعادلات، أو الأمثلة المذكورة في السؤال (Prompt) داخل بطاقة المذاكرة (studyBody).\n\nيجب اتباع الآتي:\n1. اشرح القاعدة العامة أو المفهوم.\n2. استخدم أمثلة موازية (أرقام مختلفة، متغيرات مختلفة، أو مواقف مشابهة ولكن ليست متطابقة).\n3. اجعل الطالب يستنتج الحل بنفسه بناءً على ما فهمه من البطاقة.\n" +
    lengthStudyBodyLine +
    "— جودة studyBody: لا تجعل البطاقة مجرد إجابة جافة؛ اجعلها غنية ومركزة. يُفضّل (إن أمكن) تعريف مبسط مع مثال قصير جداً يوضح الفكرة. ركز على جودة الشرح وسهولة الاستيعاب.\n";

  return (
    "دورك: أنت تُنشئ محتوى درس لتطبيق تعليمي بالعربية.\n\n" +
    "المخرجات: JSON صالح فقط (سطر واحد أو متعدد)، بدون نص قبله أو بعده وبدون Markdown أو تعليقات.\n\n" +
    "🚨 داخل القيم النصية (prompt، options، studyBody، العناوين): لا تُدرج علامة التنصيص المزدوجة U+0022 حرفياً داخل النص؛ استخدم « » أو اقتباساً مفرداً أو أقواساً أو أعد الصياغة. إن اضطررت تقنياً لعلامة مزدوجة داخل سلسلة JSON فاستخدم الهروب القياسي JSON (شرطة مائلة ثم علامة مزدوجة) داخل تلك السلسلة فقط؛ الأفضل تجنّب ذلك.\n\n" +
    strictJsonRules +
    "مثال شكل صالح (اتبع نفس الأسماء والتعشيش؛ وسّع المحتوى والأعداد حسب القيود أدناه وليس حسب حجم المثال):\n" +
    jsonShapeExample +
    "\n\nهيكل الجذر:\n" +
    "— lesson: title (نص غير فارغ)، slug (نص أو null)، description (نص أو null)، defaultAnswerMs (عدد صحيح بالمللي ثانية بين 3000 و120000)، sortOrder (عدد صحيح ≥0، يُفضّل 0).\n" +
    `— sections: مصفوفة طولها بالضبط ${p.nSec}؛ كل عنصر: titleAr (نص أو null)، studyPhaseMs (عدد صحيح بالمللي ثانية)، items (مصفوفة أسئلة).\n` +
    "لا تُضمّن lessonCategoryId ولا أي حقل لتصنيف الدرس في JSON.\n\n" +
    sectionBlock +
    "\n\nكل سؤال داخل items يجب أن يحتوي:\n" +
    "prompt، options (مصفوفة نصوص بطول 2 أو 4 — استخدم 4 خيارات ما لم يُطلب غير ذلك)، correctIndex (عدد صحيح حسب طول options أعلاه)، difficulty: easy أو medium أو hard، studyBody (نص غير فارغ)، answerMs اختياري (عدد أو null)، subcategoryKey اختياري (نص مثل general_default).\n" +
    `قائمة تحقق قبل الإرسال: طول sections = ${p.nSec}؛ طول items في كل قسم = ${p.qSame}؛ defaultAnswerMs في lesson = ${defaultAnswerMs}؛ studyPhaseMs في كل قسم = ${studyPhaseMsUnified}؛ كل options إما 2 أو 4 عناصر؛ كل studyBody غير فارغ.\n` +
    qualityBlock +
    "\nقيود المعطيات لهذا الطلب:\n" +
    `— عدد الأقسام: ${p.nSec}.\n` +
    `— عدد الأسئلة في كل قسم موحّد: ${p.qSame} لكل من الأقسام الـ ${p.nSec}.\n` +
    `— defaultAnswerMs للدرس: ${defaultAnswerMs} مللي ثانية (${p.ansSec} ثانية).\n` +
    `— زمن مذاكرة كل قسم موحّد: studyPhaseMs = ${studyPhaseMsUnified} مللي ثانية (${p.studySec} ثانية) لجميع الأقسام.\n` +
    topicBlock +
    "\nاملأ النصوص التعليمية بالعربية المناسبة للجمهور. تأكد أن كل قسم يطابق أعداد items وstudyPhaseMs أعلاه وأن الخيارات والإجابة الصحيحة متسقة.\n\n" +
    "أخرج JSON الآن.\n\n" +
    "(اختياري عند اللصق في أداة تفصل رسالة النظام عن المستخدم: ضع التعليمات أعلاه في رسالة المستخدم، وصفّ دور النموذج في رسالة النظام كمُنشئ JSON عربي لتطبيق تعليمي دون تعليق خارج JSON.)"
  );
}

/** برومبت درس مخصص: يضيف نص «ماذا تريد أن تتعلّم» بعد فقرة الدور */
export function buildCustomLessonAiPromptText(
  raw: LessonAiPromptParams & { learningIntent: string },
): string {
  const intent = String(raw.learningIntent ?? "").trim();
  const base = buildLessonAiPromptText(raw);
  if (!intent) return base;
  const marker = "\n\nالمخرجات:";
  const i = base.indexOf(marker);
  if (i < 0) return `ما يريد المستخدم تعلّمه:\n${intent}\n\n${base}`;
  return (
    base.slice(0, i) +
    `\n\nما يريد المستخدم تعلّمه (دمج إلزامي في الدرس والأسئلة والبطاقات):\n${intent}` +
    base.slice(i)
  );
}
