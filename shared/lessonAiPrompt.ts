/**
 * مصدر واحد لمولّد برومبت إنشاء درس JSON (عميل + خادم + لوحة الإدارة).
 * التوليد: قالب نصي واحد + استبدال {{متغيرات}} — بدون «بلوكات» تُبنى في الخلفية.
 * النصوص الطويلة تكون في القالب (الافتراضي أو المخزَّن) وليس في دوال مخفية.
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

export type ClampedLessonAiPromptParams = ReturnType<typeof clampLessonPromptParams>;

/** متغيرات مدعومة رسمياً — قيم مباشرة + {{jsonExample}} فقط (نهج يعتمد على نية التعلّم). */
export const LESSON_AI_PROMPT_TEMPLATE_VARIABLE_KEYS = [
  "learningIntent",
  "nSec",
  "qSame",
  "ansSec",
  "studySec",
  "minSentences",
  "maxSentences",
  "jsonExample",
] as const;

export type LessonAiPromptTemplateKey = (typeof LESSON_AI_PROMPT_TEMPLATE_VARIABLE_KEYS)[number];

/** أسماء placeholders لم تعد تُستبدل — إن وُجدت في قالب مخزَّن يُستخدم القالب الافتراضي الجديد عند الدمج. */
export const LESSON_AI_PROMPT_LEGACY_PLACEHOLDER_NAMES = [
  "learningIntentSection",
  "topicBlock",
  "qualityBlock",
  "sectionBlock",
  "structureAndItems",
  "paramsAndTopic",
  "strictJsonRules",
  "topic",
  "audience",
  "defaultAnswerMs",
  "studyPhaseMs",
] as const;

export function lessonAiPromptTemplateContainsLegacyPlaceholders(template: string): boolean {
  return LESSON_AI_PROMPT_LEGACY_PLACEHOLDER_NAMES.some((name) =>
    new RegExp(`\\{\\{\\s*${escapeRegExp(name)}\\s*\\}\\}`).test(template),
  );
}

export function clampLessonPromptParams(p: LessonAiPromptParams): LessonAiPromptParams {
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

/** مثال JSON بالأشكال والأرقام المشتقة من المعاملات — المعنى الوحيد للـ «تجميع» غير النص الصريح في القالب. */
export function buildLessonAiPromptJsonExample(p: ClampedLessonAiPromptParams): string {
  const defaultAnswerMs = Math.round(p.ansSec * 1000);
  const studyPhaseMsUnified = Math.round(p.studySec * 1000);
  return JSON.stringify(
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
              studyBody: "نص بطاقة المذاكرة.",
            },
          ],
        },
      ],
    },
    null,
    2,
  );
}

/**
 * خريطة استبدال {{المفتاح}} — القيم الفارغة للنصوص تكون "".
 * لا توجد حقول «بلوك» ضخمة؛ كل شيء آخر يجب أن يظهر في نص القالب نفسه.
 */
export function buildLessonAiPromptVariableMap(
  p: ClampedLessonAiPromptParams,
  extras: { learningIntent?: string },
): Record<string, string> {
  const learningIntent = String(extras.learningIntent ?? "").trim();
  return {
    learningIntent,
    nSec: String(p.nSec),
    qSame: String(p.qSame),
    ansSec: String(p.ansSec),
    studySec: String(p.studySec),
    minSentences: String(p.minSentences),
    maxSentences: String(p.maxSentences),
    jsonExample: buildLessonAiPromptJsonExample(p),
  };
}

/**
 * يستبدل {{مفتاح}} بالترتيب (أطول المفاتيح أولاً لتفادي التضارب).
 * أي {{غير_معروف}} يُترك كما هو.
 */
export function applyLessonAiPromptTemplate(template: string, vars: Record<string, string>): string {
  const keys = Object.keys(vars).sort((a, b) => b.length - a.length);
  let out = template;
  for (const key of keys) {
    const val = vars[key] ?? "";
    const pat = new RegExp(`\\{\\{\\s*${escapeRegExp(key)}\\s*\\}\\}`, "g");
    out = out.replace(pat, val);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * القالب الافتراضي كامل النص — لا توجد أجزاء تُولَّد خارج هذا النص سوى استبدال المتغيرات أعلاه و{{jsonExample}}.
 */
export const DEFAULT_LESSON_AI_PROMPT_TEMPLATE =
  "دورك: أنت تُنشئ محتوى درس لتطبيق تعليمي بالعربية.\n\n" +
  "ما يريد المستخدم تعلّمه — ادمجه إلزامياً في الدرس والأسئلة وبطاقات المذاكرة إن كان النص التالي غير فارغ:\n" +
  "{{learningIntent}}\n\n" +
  "المخرجات: JSON صالح فقط (سطر واحد أو متعدد)، بدون نص قبله أو بعده وبدون Markdown أو تعليقات.\n\n" +
  "🚨 داخل القيم النصية (prompt، options، studyBody، العناوين): لا تُدرج علامة التنصيص المزدوجة U+0022 حرفياً داخل النص؛ استخدم « » أو اقتباساً مفرداً أو أقواساً أو أعد الصياغة. إن اضطررت تقنياً لعلامة مزدوجة داخل سلسلة JSON فاستخدم الهروب القياسي JSON (شرطة مائلة ثم علامة مزدوجة) داخل تلك السلسلة فقط؛ الأفضل تجنّب ذلك.\n\n" +
  "قواعد JSON القياسية (RFC 8259) — إلزامي:\n" +
  "— المخرجات = كائن جذر واحد فقط يحتوي المفتاحين lesson و sections بالضبط؛ لا مفاتيح إضافية في الجذر.\n" +
  "— جميع مفاتيح الكائنات والسلاسل النصية بين علامتي تنصيص مزدوجة ASCII (\")؛ يُمنع استخدام علامات التنصيص المفردة (') كحدود لسلسلة JSON.\n" +
  "— الأرقام (defaultAnswerMs، studyPhaseMs، correctIndex، sortOrder) يجب أن تكون أرقاماً JSON خامة بلا علامات اقتباس.\n" +
  "— correctIndex: إن كان options بطول 2 فالمسموح 0 أو 1 فقط؛ إن كان بطول 4 فالمسموح 0 أو 1 أو 2 أو 3 فقط.\n" +
  "— لا تلف المخرجات داخل سياج Markdown ولا تسبقها أو تلحقها بأي نص؛ لا تعليقات // ولا /* */ داخل JSON.\n" +
  "— لا فاصلة ختامية بعد آخر عنصر في {} أو []. لا تستخدم undefined أو NaN أو Infinity.\n" +
  "— slug وdescription يمكن أن تكون null أو نصاً؛ sortOrder عدد صحيح (استخدم 0 إن لم يكن لديك تفضيل).\n\n" +
  "مثال شكل صالح (اتبع نفس الأسماء والتعشيش؛ وسّع المحتوى والأعداد حسب القيود أدناه وليس حسب حجم المثال):\n" +
  "{{jsonExample}}\n\n" +
  "هيكل الجذر:\n" +
  "— lesson: title (نص غير فارغ)، slug (نص أو null)، description (نص أو null)، defaultAnswerMs (عدد صحيح بالمللي ثانية بين 3000 و120000)، sortOrder (عدد صحيح ≥0، يُفضّل 0).\n" +
  "— sections: مصفوفة طولها بالضبط {{nSec}}؛ كل عنصر: titleAr (نص أو null)، studyPhaseMs (عدد صحيح بالمللي ثانية)، items (مصفوفة أسئلة).\n" +
  "لا تُضمّن lessonCategoryId ولا أي حقل لتصنيف الدرس في JSON.\n\n" +
  "جميع الأقسام الـ {{nSec}}: لكل قسم items بعدد موحّد {{qSame}} سؤالاً. زمن مذاكرة كل قسم مطلوب بالثواني: {{studySec}} ثانية لكل قسم — في JSON يُعبَّأ الحقل studyPhaseMs بالمللي ثانية وبما يطابق هذا الزمن تماماً كما في {{jsonExample}}.\n\n" +
  "كل سؤال داخل items يجب أن يحتوي:\n" +
  "prompt، options (مصفوفة نصوص بطول 2 أو 4 — استخدم 4 خيارات ما لم يُطلب غير ذلك)، correctIndex (عدد صحيح حسب طول options أعلاه)، studyBody (نص غير فارغ)، answerMs اختياري (عدد أو null)، subcategoryKey اختياري (نص مثل general_default). ركّز الجهد على جودة الشرح والمشتتات وبطاقات المذاكرة.\n" +
  "قائمة تحقق قبل الإرسال: طول sections = {{nSec}}؛ طول items في كل قسم = {{qSame}}؛ defaultAnswerMs في lesson يعادل مدة الإجابة {{ansSec}} ثانية (بالمللي ثانية كما في المثال JSON)؛ studyPhaseMs لكل قسم يعادل {{studySec}} ثانية لكل قسم؛ كل options إما 2 أو 4 عناصر؛ كل studyBody غير فارغ.\n\n" +
  "جودة المحتوى (إلزامي اتباع الروح):\n" +
  "— المشتتات: اجعل الخيارات الخاطئة من نفس المجال وتبدو معقولة لمن لم يقرأ بطاقة المذاكرة جيداً؛ تجنّب الخيارات السخيفة أو البديهية جداً.\n" +
  "— تطابق المذاكرة والاختبار: يجب أن يوفّر studyBody المفهوم أو المهارة التي تمكّن الطالب من الإجابة الصحيحة، دون تلقين الحل المباشر ودون إعادة نفس أرقام السؤال أو معادلاته أو أمثلته؛ قدّم المعلومة اللازمة كشرح مفهومي أو قاعدة عامة يستنتج منها الطالب الحل. لا تطلب معلومة خارج ما علّمته البطاقة.\n" +
  "— بناء المعرفة ومنع تسريب الحل (قاعدة صارمة): الهدف من البطاقة هو إكساب الطالب المهارة وليس حل المسألة له. يُحظر تماماً (Strictly Forbidden) استخدام نفس الأرقام، المعادلات، أو الأمثلة المذكورة في السؤال (Prompt) داخل بطاقة المذاكرة (studyBody).\n\nيجب اتباع الآتي:\n1. اشرح القاعدة العامة أو المفهوم.\n2. استخدم أمثلة موازية (أرقام مختلفة، متغيرات مختلفة، أو مواقف مشابهة ولكن ليست متطابقة).\n3. اجعل الطالب يستنتج الحل بنفسه بناءً على ما فهمه من البطاقة.\n" +
  "— الطول: استخدم من {{minSentences}} إلى {{maxSentences}} جملة كحد أقصى، مركزة وغنية.\n" +
  "— جودة studyBody: لا تجعل البطاقة مجرد إجابة جافة؛ اجعلها غنية ومركزة. يُفضّل (إن أمكن) تعريف مبسط مع مثال قصير جداً يوضح الفكرة. ركز على جودة الشرح وسهولة الاستيعاب.\n\n" +
  "قيود المعطيات لهذا الطلب:\n" +
  "— عدد الأقسام: {{nSec}}.\n" +
  "— عدد الأسئلة في كل قسم موحّد: {{qSame}} لكل من الأقسام الـ {{nSec}}.\n" +
  "— مدة الإجابة الافتراضية للدرس: {{ansSec}} ثانية (في JSON: defaultAnswerMs بالمللي ثانية كما في المثال).\n" +
  "— زمن مذاكرة كل قسم بالثواني: {{studySec}} ثانية لكل قسم (في JSON: studyPhaseMs بالمللي ثانية كما في المثال).\n\n" +
  "املأ النصوص التعليمية بالعربية بما يتماشى مع نية التعلّم أعلاه. تأكد أن كل قسم يطابق الأعداد والأزمنة وأن الخيارات والإجابة الصحيحة متسقة مع {{jsonExample}}.\n\n" +
  "تذكير قبل الإخراج: إن احتجت علامة تنصيص مزدوجة ASCII داخل قيمة JSON، استخدم الهروب كما في \"studyBody\": \"قالت \\\"مرحباً\\\" للجميع\" — أو الأفضل استعمال «مرحباً» وغيرها من علامات الاقتباس العربية بدل إدراج \\\" داخل السلسلة.\n\n" +
  "أخرج JSON الآن.\n\n" +
  "(اختياري عند اللصق في أداة تفصل رسالة النظام عن المستخدم: ضع التعليمات أعلاه في رسالة المستخدم، وصفّ دور النموذج في رسالة النظام كمُنشئ JSON عربي لتطبيق تعليمي دون تعليق خارج JSON.)";

export type BuildLessonAiPromptOptions = {
  /** إن وُجد وغير فارغ بعد التقليم يُستخدم؛ وإلا القالب الافتراضي. */
  promptTemplate?: string | null;
};

export function buildLessonAiPromptText(raw: LessonAiPromptParams, options?: BuildLessonAiPromptOptions | null): string {
  const p = clampLessonPromptParams(raw);
  const vars = buildLessonAiPromptVariableMap(p, { learningIntent: "" });
  const tpl = pickTemplate(options?.promptTemplate);
  return applyLessonAiPromptTemplate(tpl, vars);
}

/** برومبت درس مخصص: نفس القالب مع تمرير learningIntent في الخريطة. */
export function buildCustomLessonAiPromptText(
  raw: LessonAiPromptParams & { learningIntent: string },
  options?: BuildLessonAiPromptOptions | null,
): string {
  const p = clampLessonPromptParams(raw);
  const vars = buildLessonAiPromptVariableMap(p, { learningIntent: raw.learningIntent });
  const tpl = pickTemplate(options?.promptTemplate);
  return applyLessonAiPromptTemplate(tpl, vars);
}

function pickTemplate(custom: string | null | undefined): string {
  if (typeof custom !== "string") return DEFAULT_LESSON_AI_PROMPT_TEMPLATE;
  const t = custom.trim();
  return t.length > 0 ? t : DEFAULT_LESSON_AI_PROMPT_TEMPLATE;
}

export const DEFAULT_CUSTOM_LESSON_AUDIENCE_OPTIONS: ReadonlyArray<{ v: string; t: string }> = [
  { v: "", t: "— بدون تحديد —" },
  { v: "أطفال", t: "أطفال" },
  { v: "مبتدئ", t: "مبتدئ" },
  { v: "ثانوي", t: "ثانوي" },
  { v: "جامعي", t: "جامعي" },
  { v: "متخصصون", t: "متخصصون" },
];

export const DEFAULT_CUSTOM_LESSON_PROMPT_DEFAULTS: LessonAiPromptParams = {
  nSec: 3,
  qSame: 5,
  ansSec: 15,
  studySec: 60,
  topic: "",
  audience: "",
  minSentences: 1,
  maxSentences: 6,
};
