/** تقسيم الاسم المعروض للملف الشخصي (أول مسافة → الاسم الأول والباقي للأخير). */
export function splitDisplayNameForProfile(displayName: string | null | undefined): {
  firstName: string | null;
  lastName: string | null;
} {
  const s = String(displayName ?? "").trim();
  if (!s) return { firstName: null, lastName: null };
  const i = s.indexOf(" ");
  if (i === -1) return { firstName: s, lastName: null };
  const first = s.slice(0, i).trim();
  const last = s.slice(i + 1).trim();
  return { firstName: first || null, lastName: last || null };
}
