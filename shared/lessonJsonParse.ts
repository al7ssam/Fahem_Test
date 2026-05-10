import { jsonrepair } from "jsonrepair";

/** رسالة توضيحية عند فشل كل مسارات التحليل الآمنة */
export const LESSON_JSON_PARSE_HINT_AR =
  "تعذر تحليل JSON. السبب الشائع: علامات تنصيص مزدوجة (\") داخل نصوص مثل studyBody أو prompt دون الهروب — استخدم علامات «» أو أضف \\ قبل كل علامة \" داخل النص.";

/**
 * إزالة BOM وأغلفة Markdown وعلامات اقتباس منحنية وأحرف عرض ضيقة شائعة بعد اللصق.
 * مطابق لسلوك العميل السابق في `client/src/jsonNormalize.ts`.
 */
export function normalizePastedJsonForParse(raw: unknown): string {
  let s = String(raw == null ? "" : raw).trim();
  if (!s) return "";
  s = s.replace(/^\uFEFF/, "");
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, "");
  s = s.replace(/^\s*```(?:json)?\s*\r?\n?/i, "");
  s = s.replace(/\s*```\s*$/i, "");
  s = s.trim();
  s = s.replace(/\u201C/g, '"').replace(/\u201D/g, '"').replace(/\u201E/g, '"').replace(/\u2033/g, '"');
  return s.trim();
}

/**
 * يستخرج أول كائن JSON `{ ... }` متوازن الأقواس مع احترام النصوص بين علامتي تنصيص و`\\`.
 */
export function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (c === "\\") {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function stripTrailingCommasOnce(s: string): string {
  return s.replace(/,(\s*[}\]])/g, "$1");
}

/** محاولات JSON.parse مع إزالة فاصلة زائمة محدودة (حتى تمريرين). */
export function parseJsonLenient(s: string): unknown | null {
  let cur = s;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return JSON.parse(cur) as unknown;
    } catch {
      const next = stripTrailingCommasOnce(cur);
      if (next === cur) break;
      cur = next;
    }
  }
  return null;
}

export type ParseLessonPastedJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; detail: string };

/**
 * تحليل نص درس مُلصَق من نموذج لغوي: تطبيع، استخراج الجذر، فاصلة زائمة، ثم jsonrepair كمسار احتياطي واحد.
 */
export function parseLessonPastedJson(raw: unknown): ParseLessonPastedJsonResult {
  const normalized = normalizePastedJsonForParse(raw);
  if (!normalized) {
    return { ok: false, detail: "الصق JSON الدرس أولاً." };
  }

  const extracted = extractFirstJsonObject(normalized);
  const candidate = extracted ?? normalized;

  let value = parseJsonLenient(candidate);
  if (value != null) return { ok: true, value };

  if (extracted != null && extracted !== normalized) {
    value = parseJsonLenient(normalized);
    if (value != null) return { ok: true, value };
  }

  const tryRepair = (src: string): unknown | null => {
    try {
      const repaired = jsonrepair(src);
      return parseJsonLenient(repaired);
    } catch {
      return null;
    }
  };

  value = tryRepair(candidate);
  if (value != null) return { ok: true, value };

  if (candidate !== normalized) {
    value = tryRepair(normalized);
    if (value != null) return { ok: true, value };
  }

  return { ok: false, detail: LESSON_JSON_PARSE_HINT_AR };
}
