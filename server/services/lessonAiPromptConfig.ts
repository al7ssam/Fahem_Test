import type { Pool } from "pg";
import { z } from "zod";
import type { LessonAiPromptParams } from "../../shared/lessonAiPrompt";
import {
  DEFAULT_CUSTOM_LESSON_AUDIENCE_OPTIONS,
  DEFAULT_CUSTOM_LESSON_PROMPT_DEFAULTS,
  DEFAULT_LESSON_AI_PROMPT_TEMPLATE,
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

/** Legacy — قراءة فقط من النسخ القديمة */
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

const MAX_PROMPT_TEMPLATE_CHARS = 200_000;

export const lessonAiPromptStoredConfigV2Schema = z
  .object({
    version: z.literal(2),
    promptTemplate: z.string().max(MAX_PROMPT_TEMPLATE_CHARS),
    defaults: lessonParamsPartialSchema.optional(),
    audienceOptions: z.array(z.object({ v: z.string(), t: z.string() })).optional(),
  })
  .strict();

export type LessonAiPromptStoredConfigV2 = z.infer<typeof lessonAiPromptStoredConfigV2Schema>;

export type LessonAiPromptStoredUnion = LessonAiPromptStoredConfigV1 | LessonAiPromptStoredConfigV2;

export type ResolvedLessonAiPromptPublicConfig = {
  defaults: LessonAiPromptParams;
  audienceOptions: Array<{ v: string; t: string }>;
  /** القالب الفعلي للتوليد (من DB أو الافتراضي من الكود). */
  promptTemplate: string;
};

export function mergeLessonAiPromptStored(stored: LessonAiPromptStoredUnion | null): ResolvedLessonAiPromptPublicConfig {
  const partial =
    stored && (stored.version === 1 || stored.version === 2) && stored.defaults ? stored.defaults : {};
  const defaults: LessonAiPromptParams = {
    ...DEFAULT_CUSTOM_LESSON_PROMPT_DEFAULTS,
    ...partial,
  };
  const audienceOptions =
    stored &&
    "audienceOptions" in stored &&
    stored.audienceOptions &&
    stored.audienceOptions.length > 0
      ? [...stored.audienceOptions]
      : [...DEFAULT_CUSTOM_LESSON_AUDIENCE_OPTIONS];

  let promptTemplate = DEFAULT_LESSON_AI_PROMPT_TEMPLATE;
  if (stored?.version === 2 && typeof stored.promptTemplate === "string") {
    const t = stored.promptTemplate.trim();
    if (t.length > 0) promptTemplate = stored.promptTemplate;
  }

  return {
    defaults,
    audienceOptions,
    promptTemplate,
  };
}

function parseStoredJson(raw: unknown): LessonAiPromptStoredUnion | null {
  const v2 = lessonAiPromptStoredConfigV2Schema.safeParse(raw);
  if (v2.success) return v2.data;
  const v1 = lessonAiPromptStoredConfigV1Schema.safeParse(raw);
  if (v1.success) return v1.data;
  return null;
}

export async function getLessonAiPromptStored(pool: Pool): Promise<LessonAiPromptStoredUnion | null> {
  const r = await pool.query<{ value: string }>(
    `SELECT value FROM public.app_settings WHERE key = $1 LIMIT 1`,
    [LESSON_AI_PROMPT_SETTINGS_KEY],
  );
  const raw = r.rows[0]?.value;
  if (raw == null || raw === "") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parseStoredJson(parsed);
  } catch {
    return null;
  }
}

export async function saveLessonAiPromptStored(
  pool: Pool,
  body: unknown,
  note: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = lessonAiPromptStoredConfigV2Schema.safeParse(body);
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
  payload: LessonAiPromptStoredUnion;
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
    const p = parseStoredJson(row.payload);
    if (!p) continue;
    out.push({
      id: Number(row.id),
      created_at: row.created_at.toISOString(),
      payload: p,
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
  const parsed = parseStoredJson(payload);
  if (!parsed) return false;
  const json = JSON.stringify(parsed);
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
