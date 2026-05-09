import countries from "i18n-iso-countries";

let cached: Set<string> | null = null;

/** كل رموز ISO alpha-2 المعروفة للمكتبة، ناقص IL صراحة (سياسة المنتج). */
export function getAllowedCountryCodes(): Set<string> {
  if (!cached) {
    const alpha2 = countries.getAlpha2Codes();
    cached = new Set(Object.keys(alpha2));
    cached.delete("IL");
  }
  return cached;
}

export function isAllowedCountryCode(code: string): boolean {
  const u = code.trim().toUpperCase();
  if (u === "IL") return false;
  return getAllowedCountryCodes().has(u);
}
