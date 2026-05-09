import { z } from "zod";
import { isAllowedCountryCode } from "./allowedCountries";

function parseIsoDateOnly(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

export const patchProfileBodySchema = z
  .object({
    firstName: z.string().min(1).max(120).optional(),
    lastName: z.union([z.string().max(120), z.null()]).optional(),
    birthDate: z.union([z.string(), z.null()]).optional(),
    countryCode: z.string().length(2).optional(),
  })
  .strict();

export type PatchProfileBody = z.infer<typeof patchProfileBodySchema>;

export function validateBirthDateInput(raw: string | null): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === null) return { ok: true, value: null };
  const s = String(raw).trim();
  if (!s) return { ok: true, value: null };
  const dt = parseIsoDateOnly(s);
  if (!dt) return { ok: false, error: "invalid_birth_date" };
  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (dt > todayUtc) return { ok: false, error: "birth_date_future" };
  const min = new Date(Date.UTC(1900, 0, 1));
  if (dt < min) return { ok: false, error: "birth_date_too_old" };
  return { ok: true, value: s };
}

export function validateCountryCodeInput(code: string): { ok: true; value: string } | { ok: false; error: string } {
  const u = code.trim().toUpperCase();
  if (!isAllowedCountryCode(u)) return { ok: false, error: "invalid_country_code" };
  return { ok: true, value: u };
}
