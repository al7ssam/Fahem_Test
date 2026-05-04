import type { Pool } from "pg";

export const DEFAULT_GAME_QUESTION_MS = 15_000;
export const DEFAULT_GAME_STUDY_PHASE_MS = 60_000;

export function clampGameQuestionMs(ms: number): number {
  return Math.min(120_000, Math.max(5_000, Math.floor(ms)));
}

export function clampGameStudyPhaseMs(ms: number): number {
  return Math.min(300_000, Math.max(10_000, Math.floor(ms)));
}

export function resolveQuestionMsFromAppSetting(value: string | undefined): number {
  const n = Number(value);
  return clampGameQuestionMs(Number.isFinite(n) ? n : DEFAULT_GAME_QUESTION_MS);
}

export function resolveStudyPhaseMsFromAppSetting(value: string | undefined): number {
  const n = Number(value);
  return clampGameStudyPhaseMs(Number.isFinite(n) ? n : DEFAULT_GAME_STUDY_PHASE_MS);
}

export async function fetchGameTimingFromAppSettings(
  pool: Pool,
): Promise<{ questionMs: number; studyPhaseMs: number }> {
  const r = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM app_settings WHERE key IN ('game_question_ms', 'game_study_phase_ms')`,
  );
  const map = new Map(r.rows.map((row) => [row.key, row.value]));
  return {
    questionMs: resolveQuestionMsFromAppSetting(map.get("game_question_ms")),
    studyPhaseMs: resolveStudyPhaseMsFromAppSetting(map.get("game_study_phase_ms")),
  };
}
