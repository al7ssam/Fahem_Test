import { getPool } from "../db/pool";
import { ensureProfileRowExists } from "../profile/repository";
import type { LessonAiPromptParams } from "../../shared/lessonAiPrompt";
import { clampCustomLessonFlowParams } from "../../shared/lessonAiPrompt";

export async function getCustomLessonPromptParamsForUser(
  userId: string,
): Promise<LessonAiPromptParams | null> {
  await ensureProfileRowExists(userId);
  const pool = getPool();
  const r = await pool.query<{ custom_lesson_prompt_params: unknown }>(
    `SELECT custom_lesson_prompt_params
       FROM public.user_profiles
      WHERE user_id = $1::uuid`,
    [userId],
  );
  const raw = r.rows[0]?.custom_lesson_prompt_params;
  if (raw == null || typeof raw !== "object") return null;
  try {
    const o = raw as Record<string, unknown>;
    const p: LessonAiPromptParams = {
      nSec: Number(o.nSec),
      qSame: Number(o.qSame),
      ansSec: Number(o.ansSec),
      studySec: Number(o.studySec),
      topic: "",
      audience: String(o.audience ?? ""),
      minSentences: Number(o.minSentences),
      maxSentences: Number(o.maxSentences),
    };
    return clampCustomLessonFlowParams(p);
  } catch {
    return null;
  }
}

export async function setCustomLessonPromptParamsForUser(
  userId: string,
  params: LessonAiPromptParams,
): Promise<LessonAiPromptParams> {
  await ensureProfileRowExists(userId);
  const clamped = clampCustomLessonFlowParams(params);
  const pool = getPool();
  await pool.query(
    `UPDATE public.user_profiles
        SET custom_lesson_prompt_params = $2::jsonb
      WHERE user_id = $1::uuid`,
    [userId, JSON.stringify({ ...clamped, topic: "" })],
  );
  return clamped;
}

export async function clearCustomLessonPromptParamsForUser(userId: string): Promise<void> {
  await ensureProfileRowExists(userId);
  const pool = getPool();
  await pool.query(
    `UPDATE public.user_profiles
        SET custom_lesson_prompt_params = NULL
      WHERE user_id = $1::uuid`,
    [userId],
  );
}
