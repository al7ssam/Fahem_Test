import type { Pool } from "pg";
import { z } from "zod";

export const USER_SAVED_LESSONS_POLICY_KEY = "user_saved_lessons_policy_v1";

export const userSavedLessonsPolicyStoredSchema = z
  .object({
    version: z.literal(1),
    retentionDays: z.number().int().min(1).max(3650),
    maxLessonsPerUser: z.number().int().min(1).max(500),
  })
  .strict();

export type UserSavedLessonsPolicyStored = z.infer<typeof userSavedLessonsPolicyStoredSchema>;

export const DEFAULT_USER_SAVED_LESSONS_POLICY: UserSavedLessonsPolicyStored = {
  version: 1,
  retentionDays: 90,
  maxLessonsPerUser: 20,
};

export type ResolvedUserSavedLessonsPolicy = UserSavedLessonsPolicyStored;

export function mergeUserSavedLessonsPolicy(stored: UserSavedLessonsPolicyStored | null): ResolvedUserSavedLessonsPolicy {
  if (!stored) return { ...DEFAULT_USER_SAVED_LESSONS_POLICY };
  return {
    version: 1,
    retentionDays: stored.retentionDays,
    maxLessonsPerUser: stored.maxLessonsPerUser,
  };
}

export async function getUserSavedLessonsPolicyStored(pool: Pool): Promise<UserSavedLessonsPolicyStored | null> {
  const r = await pool.query<{ value: string }>(
    `SELECT value FROM public.app_settings WHERE key = $1 LIMIT 1`,
    [USER_SAVED_LESSONS_POLICY_KEY],
  );
  const raw = r.rows[0]?.value;
  if (raw == null || raw === "") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const v = userSavedLessonsPolicyStoredSchema.safeParse(parsed);
    return v.success ? v.data : null;
  } catch {
    return null;
  }
}

export async function saveUserSavedLessonsPolicyStored(
  pool: Pool,
  body: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = userSavedLessonsPolicyStoredSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: "invalid_body" };
  }
  const json = JSON.stringify(parsed.data);
  await pool.query(
    `INSERT INTO public.app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [USER_SAVED_LESSONS_POLICY_KEY, json],
  );
  return { ok: true };
}
