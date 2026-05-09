import { getPool } from "../db/pool";
import type { PatchProfileBody } from "./schemas";
import { validateBirthDateInput, validateCountryCodeInput } from "./schemas";

export type UserProfileDto = {
  firstName: string | null;
  lastName: string | null;
  birthDate: string | null;
  countryCode: string;
  profileCompletedAt: string | null;
};

function rowBirthToIso(birth: unknown): string | null {
  if (birth == null) return null;
  if (birth instanceof Date) return birth.toISOString().slice(0, 10);
  const s = String(birth);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

export async function ensureProfileRowExists(userId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO public.user_profiles (user_id, country_code)
     VALUES ($1::uuid, 'SA')
     ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
}

export async function getProfileByUserId(userId: string): Promise<UserProfileDto | null> {
  await ensureProfileRowExists(userId);
  const pool = getPool();
  const r = await pool.query<{
    first_name: string | null;
    last_name: string | null;
    birth_date: unknown;
    country_code: string;
    profile_completed_at: Date | null;
  }>(
    `SELECT first_name,
            last_name,
            birth_date,
            country_code::text AS country_code,
            profile_completed_at
       FROM public.user_profiles
      WHERE user_id = $1::uuid`,
    [userId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    firstName: row.first_name,
    lastName: row.last_name,
    birthDate: rowBirthToIso(row.birth_date),
    countryCode: row.country_code.trim().toUpperCase(),
    profileCompletedAt: row.profile_completed_at ? row.profile_completed_at.toISOString() : null,
  };
}

export async function patchProfileByUserId(userId: string, patch: PatchProfileBody): Promise<UserProfileDto | null> {
  await ensureProfileRowExists(userId);
  const current = await getProfileByUserId(userId);
  if (!current) return null;

  let firstName = current.firstName;
  let lastName = current.lastName;
  let birthDate = current.birthDate;
  let countryCode = current.countryCode;

  if (patch.firstName !== undefined) {
    firstName = patch.firstName.trim();
  }
  if (patch.lastName !== undefined) {
    lastName = patch.lastName === null ? null : patch.lastName.trim();
  }
  if (patch.birthDate !== undefined) {
    const v = validateBirthDateInput(patch.birthDate);
    if (!v.ok) throw new Error(v.error);
    birthDate = v.value;
  }
  if (patch.countryCode !== undefined) {
    const v = validateCountryCodeInput(patch.countryCode);
    if (!v.ok) throw new Error(v.error);
    countryCode = v.value;
  }

  const nameTrimmed = (firstName ?? "").trim();
  const shouldMarkCompleted =
    nameTrimmed.length > 0 && Boolean(countryCode) && current.profileCompletedAt === null;

  const pool = getPool();
  const r = await pool.query<{
    first_name: string | null;
    last_name: string | null;
    birth_date: unknown;
    country_code: string;
    profile_completed_at: Date | null;
  }>(
    `UPDATE public.user_profiles
        SET first_name = $2::text,
            last_name = $3::text,
            birth_date = $4::date,
            country_code = $5::bpchar,
            profile_completed_at = CASE
              WHEN $6::boolean THEN COALESCE(profile_completed_at, NOW())
              ELSE profile_completed_at
            END
      WHERE user_id = $1::uuid
  RETURNING first_name,
            last_name,
            birth_date,
            country_code::text AS country_code,
            profile_completed_at`,
    [userId, firstName, lastName, birthDate, countryCode, shouldMarkCompleted],
  );

  const row = r.rows[0];
  if (!row) return null;
  return {
    firstName: row.first_name,
    lastName: row.last_name,
    birthDate: rowBirthToIso(row.birth_date),
    countryCode: row.country_code.trim().toUpperCase(),
    profileCompletedAt: row.profile_completed_at ? row.profile_completed_at.toISOString() : null,
  };
}
