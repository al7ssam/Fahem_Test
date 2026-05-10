import type { Pool } from "pg";
import { z } from "zod";
import type {
  LessonAiPromptFragmentKey,
  LessonAiPromptParams,
  LessonAiPromptRuntimeOptions,
} from "../../shared/lessonAiPrompt";
import {
  DEFAULT_CUSTOM_LESSON_AUDIENCE_OPTIONS,
  DEFAULT_CUSTOM_LESSON_PROMPT_DEFAULTS,
} from "../../shared/lessonAiPrompt";

export const LESSON_AI_PROMPT_SETTINGS_KEY = "lesson_ai_prompt_config_v1";

const fragmentEnum = z.enum([
  "head",
  "strictJsonRules",
  "midExample",
  "jsonExample",
  "structureAndItems",
  "quality",
  "paramsAndTopic",
  "closing",
]);

const lessonParamsPartialSchema = z.object({
  nSec: z.number().optional(),
  qSame: z.number().optional(),
  ansSec: z.number().optional(),
  studySec: z.number().optional(),
  topic: z.string().optional(),
  audience: z.string().optional(),
  minSentences: z.number().optional(),
  maxSentences: z.number().optional(),
});

export const lessonAiPromptStoredConfigV1Schema = z
  .object({
    version: z.literal(1),
    defaults: lessonParamsPartialSchema.optional(),
    audienceOptions: z.array(z.object({ v: z.string(), t: z.string() })).optional(),
    fragmentEnabled: z.record(fragmentEnum, z.boolean()).optional(),
    fragmentOverrides: z.record(fragmentEnum, z.string()).optional(),
  })
  .strict();

export type LessonAiPromptStoredConfigV1 = z.infer<typeof lessonAiPromptStoredConfigV1Schema>;

export type ResolvedLessonAiPromptPublicConfig = {
  defaults: LessonAiPromptParams;
  audienceOptions: Array<{ v: string; t: string }>;
  fragmentEnabled: Partial<Record<LessonAiPromptFragmentKey, boolean>>;
  fragmentOverrides: Partial<Record<LessonAiPromptFragmentKey, string>>;
  runtimeOptions: LessonAiPromptRuntimeOptions;
};

export function mergeLessonAiPromptStored(
  stored: LessonAiPromptStoredConfigV1 | null,
): ResolvedLessonAiPromptPublicConfig {
  const defaults: LessonAiPromptParams = {
    ...DEFAULT_CUSTOM_LESSON_PROMPT_DEFAULTS,
    ...stored?.defaults,
  };
  const audienceOptions =
    stored?.audienceOptions && stored.audienceOptions.length > 0
      ? [...stored.audienceOptions]
      : [...DEFAULT_CUSTOM_LESSON_AUDIENCE_OPTIONS];
  const fragmentEnabled = { ...(stored?.fragmentEnabled ?? {}) };
  const fragmentOverrides = { ...(stored?.fragmentOverrides ?? {}) };
  const runtimeOptions: LessonAiPromptRuntimeOptions = {
    fragmentEnabled,
    fragmentOverrides,
  };
  return {
    defaults,
    audienceOptions,
    fragmentEnabled,
    fragmentOverrides,
    runtimeOptions,
  };
}

export async function getLessonAiPromptStored(pool: Pool): Promise<LessonAiPromptStoredConfigV1 | null> {
  const r = await pool.query<{ value: string }>(
    `SELECT value FROM public.app_settings WHERE key = $1 LIMIT 1`,
    [LESSON_AI_PROMPT_SETTINGS_KEY],
  );
  const raw = r.rows[0]?.value;
  if (raw == null || raw === "") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const s = lessonAiPromptStoredConfigV1Schema.safeParse(parsed);
    return s.success ? s.data : null;
  } catch {
    return null;
  }
}

export async function saveLessonAiPromptStored(
  pool: Pool,
  body: unknown,
  note: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = lessonAiPromptStoredConfigV1Schema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: "invalid_body" };
  }
  const json = JSON.stringify(parsed.data);
  await pool.query(
    `INSERT INTO public.app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [LESSON_AI_PROMPT_SETTINGS_KEY, json],
  );
  await pool.query(`INSERT INTO public.lesson_ai_prompt_versions (payload, note) VALUES ($1::jsonb, $2)`, [
    json,
    note?.trim() || null,
  ]);
  return { ok: true };
}

export type LessonAiPromptVersionRow = {
  id: number;
  created_at: string;
  payload: LessonAiPromptStoredConfigV1;
  note: string | null;
};

export async function listLessonAiPromptVersions(pool: Pool, limit = 30): Promise<LessonAiPromptVersionRow[]> {
  const lim = Math.min(100, Math.max(1, Math.trunc(limit) || 30));
  const r = await pool.query<{ id: string; created_at: Date; payload: unknown; note: string | null }>(
    `SELECT id, created_at, payload, note
     FROM public.lesson_ai_prompt_versions
     ORDER BY created_at DESC
     LIMIT $1`,
    [lim],
  );
  const out: LessonAiPromptVersionRow[] = [];
  for (const row of r.rows) {
    const p = lessonAiPromptStoredConfigV1Schema.safeParse(row.payload);
    if (!p.success) continue;
    out.push({
      id: Number(row.id),
      created_at: row.created_at.toISOString(),
      payload: p.data,
      note: row.note,
    });
  }
  return out;
}

export async function restoreLessonAiPromptVersion(pool: Pool, versionId: number): Promise<boolean> {
  const r = await pool.query<{ payload: unknown }>(
    `SELECT payload FROM public.lesson_ai_prompt_versions WHERE id = $1 LIMIT 1`,
    [versionId],
  );
  const payload = r.rows[0]?.payload;
  if (payload == null) return false;
  const parsed = lessonAiPromptStoredConfigV1Schema.safeParse(payload);
  if (!parsed.success) return false;
  const json = JSON.stringify(parsed.data);
  await pool.query(
    `INSERT INTO public.app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [LESSON_AI_PROMPT_SETTINGS_KEY, json],
  );
  await pool.query(`INSERT INTO public.lesson_ai_prompt_versions (payload, note) VALUES ($1::jsonb, $2)`, [
    json,
    `استعادة من الإصدار #${versionId}`,
  ]);
  return true;
}
