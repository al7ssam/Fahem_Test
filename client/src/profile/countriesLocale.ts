import { getNames, registerLocale } from "i18n-iso-countries";
import ar from "i18n-iso-countries/langs/ar.json";

let ready = false;

export function ensureArabicCountriesLocale(): void {
  if (ready) return;
  registerLocale(ar as Parameters<typeof registerLocale>[0]);
  ready = true;
}

export function getArabicOfficialNames(): Record<string, string> {
  ensureArabicCountriesLocale();
  return getNames("ar", { select: "official" }) as Record<string, string>;
}
