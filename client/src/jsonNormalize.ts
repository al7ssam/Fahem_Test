/** إزالة BOM وأغلفة Markdown الشائعة قبل JSON.parse — يُحافظ على نفس سلوك لوحة الإدارة */
export function normalizePastedJsonForParse(raw: unknown): string {
  let s = String(raw == null ? "" : raw).trim();
  if (!s) return "";
  s = s.replace(/^\uFEFF/, "");
  s = s.replace(/^\s*```(?:json)?\s*\r?\n?/i, "");
  s = s.replace(/\s*```\s*$/i, "");
  return s.trim();
}
