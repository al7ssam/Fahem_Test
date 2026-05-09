import { getArabicOfficialNames } from "./countriesLocale";

export const GCC_ORDER = ["AE", "KW", "QA", "BH", "OM"] as const;

/** دول عربية للشريحة الثالثة (بعد السعودية والخليج)، بدون تكرار رموز الخليج والسعودية */
const OTHER_ARAB_CODES: readonly string[] = [
  "DZ",
  "KM",
  "DJ",
  "EG",
  "IQ",
  "JO",
  "LB",
  "LY",
  "MR",
  "MA",
  "PS",
  "SO",
  "SD",
  "SY",
  "TN",
  "YE",
  "EH",
];

export type CountryRow = { code: string; labelAr: string };

function sortByLabelAr(items: CountryRow[]): CountryRow[] {
  return [...items].sort((a, b) => a.labelAr.localeCompare(b.labelAr, "ar"));
}

/** ترتيب العرض: SA → الخليج → عرب آخرون → العالم؛ بدون IL */
export function buildOrderedCountryRows(): CountryRow[] {
  const names = getArabicOfficialNames();
  const allCodes = Object.keys(names).filter((c) => c !== "IL");
  const codeSet = new Set(allCodes);

  const row = (code: string): CountryRow | null => {
    const labelAr = names[code];
    if (!labelAr) return null;
    return { code, labelAr };
  };

  const out: CountryRow[] = [];
  const used = new Set<string>();

  if (codeSet.has("SA")) {
    const r = row("SA");
    if (r) {
      out.push(r);
      used.add("SA");
    }
  }

  for (const code of GCC_ORDER) {
    if (!codeSet.has(code) || used.has(code)) continue;
    const r = row(code);
    if (r) {
      out.push(r);
      used.add(code);
    }
  }

  const otherArab: CountryRow[] = [];
  for (const code of OTHER_ARAB_CODES) {
    if (!codeSet.has(code) || used.has(code)) continue;
    const r = row(code);
    if (r) {
      otherArab.push(r);
      used.add(code);
    }
  }
  out.push(...sortByLabelAr(otherArab));

  const rest: CountryRow[] = [];
  for (const code of allCodes) {
    if (used.has(code)) continue;
    const r = row(code);
    if (r) rest.push(r);
  }
  out.push(...sortByLabelAr(rest));

  return out;
}

export function filterCountryRows(rows: CountryRow[], query: string): CountryRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => r.labelAr.toLowerCase().includes(q));
}
