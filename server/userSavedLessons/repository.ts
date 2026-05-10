import type { Pool } from "pg";

export type UserSavedLessonSummaryRow = {
  id: string;
  title: string;
  expiresAt: string;
  updatedAt: string;
};

export type UserSavedLessonDetailRow = UserSavedLessonSummaryRow & {
  payload: unknown;
  createdAt: string;
};

/** حذف الصفوف المنتهية عالمياً (cron). */
export async function deleteExpiredUserSavedLessonsGlobal(pool: Pool): Promise<number> {
  const r = await pool.query(`DELETE FROM public.user_saved_lessons WHERE expires_at < NOW()`);
  return r.rowCount ?? 0;
}

/** حذف منتهية الصلاحية لمستخدم محدد (كسول مع القائمة). */
export async function deleteExpiredUserSavedLessonsForUser(pool: Pool, userId: string): Promise<number> {
  const r = await pool.query(
    `DELETE FROM public.user_saved_lessons WHERE user_id = $1 AND expires_at < NOW()`,
    [userId],
  );
  return r.rowCount ?? 0;
}

export async function countActiveSavedLessonsForUser(pool: Pool, userId: string): Promise<number> {
  const r = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM public.user_saved_lessons
     WHERE user_id = $1 AND expires_at >= NOW()`,
    [userId],
  );
  return Number(r.rows[0]?.c ?? 0);
}

export async function listActiveSavedLessonsForUser(
  pool: Pool,
  userId: string,
): Promise<UserSavedLessonSummaryRow[]> {
  const r = await pool.query<{
    id: string;
    title: string;
    expires_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, title, expires_at, updated_at FROM public.user_saved_lessons
     WHERE user_id = $1 AND expires_at >= NOW()
     ORDER BY updated_at DESC`,
    [userId],
  );
  return r.rows.map((row) => ({
    id: row.id,
    title: row.title,
    expiresAt: row.expires_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));
}

export async function getActiveSavedLessonForUser(
  pool: Pool,
  userId: string,
  lessonId: string,
): Promise<UserSavedLessonDetailRow | null> {
  const r = await pool.query<{
    id: string;
    title: string;
    payload: unknown;
    expires_at: Date;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, title, payload, expires_at, created_at, updated_at FROM public.user_saved_lessons
     WHERE user_id = $1 AND id = $2 AND expires_at >= NOW()
     LIMIT 1`,
    [userId, lessonId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    payload: row.payload,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function insertSavedLesson(
  pool: Pool,
  args: { userId: string; title: string; payload: unknown; retentionDays: number },
): Promise<UserSavedLessonDetailRow> {
  const r = await pool.query<{
    id: string;
    title: string;
    payload: unknown;
    expires_at: Date;
    created_at: Date;
    updated_at: Date;
  }>(
    `INSERT INTO public.user_saved_lessons (user_id, title, payload, expires_at)
     VALUES ($1, $2, $3::jsonb, NOW() + ($4::double precision * INTERVAL '1 day'))
     RETURNING id, title, payload, expires_at, created_at, updated_at`,
    [args.userId, args.title, JSON.stringify(args.payload), args.retentionDays],
  );
  const row = r.rows[0]!;
  return {
    id: row.id,
    title: row.title,
    payload: row.payload,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function updateSavedLesson(
  pool: Pool,
  args: {
    userId: string;
    lessonId: string;
    title: string;
    payload: unknown;
    retentionDays: number;
  },
): Promise<UserSavedLessonDetailRow | null> {
  const r = await pool.query<{
    id: string;
    title: string;
    payload: unknown;
    expires_at: Date;
    created_at: Date;
    updated_at: Date;
  }>(
    `UPDATE public.user_saved_lessons
     SET title = $3,
         payload = $4::jsonb,
         updated_at = NOW(),
         expires_at = NOW() + ($5::double precision * INTERVAL '1 day')
     WHERE user_id = $1 AND id = $2 AND expires_at >= NOW()
     RETURNING id, title, payload, expires_at, created_at, updated_at`,
    [args.userId, args.lessonId, args.title, JSON.stringify(args.payload), args.retentionDays],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    payload: row.payload,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function deleteSavedLesson(pool: Pool, userId: string, lessonId: string): Promise<boolean> {
  const r = await pool.query(`DELETE FROM public.user_saved_lessons WHERE user_id = $1 AND id = $2`, [
    userId,
    lessonId,
  ]);
  return (r.rowCount ?? 0) > 0;
}
