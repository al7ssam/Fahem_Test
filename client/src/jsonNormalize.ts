/**
 * إزالة BOM وأغلفة Markdown وعلامات اقتباس «منحنية» (شائعة بعد اللصق من الجوال أو واتساب)
 * قبل JSON.parse — يُحافظ على نفس سلوك لوحة الإدارة قدر الإمكان.
 */
export function normalizePastedJsonForParse(raw: unknown): string {
  let s = String(raw == null ? "" : raw).trim();
  if (!s) return "";
  s = s.replace(/^\uFEFF/, "");
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, "");
  s = s.replace(/^\s*```(?:json)?\s*\r?\n?/i, "");
  s = s.replace(/\s*```\s*$/i, "");
  s = s.trim();
  /* U+201C/U+201D/U+201E/U+2033: علامات تنصيص مزدوجة غير ASCII تفسد JSON.parse على الجوال */
  s = s.replace(/\u201C/g, '"').replace(/\u201D/g, '"').replace(/\u201E/g, '"').replace(/\u2033/g, '"');
  return s.trim();
}
